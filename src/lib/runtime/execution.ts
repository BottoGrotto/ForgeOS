import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeVirtualPath } from "@/lib/workspace/paths";
import type { VirtualFile } from "./types";

export type VerificationCommandId = "typecheck" | "lint" | "test" | "build" | "smoke" | "e2e";
export type VerificationTier = "development" | "acceptance";

export interface VerificationCommand {
  command: string;
  args: string[];
}

export interface VerificationResult {
  commandId: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface AutomaticVerificationSummary {
  status: "passed" | "failed" | "skipped";
  tier: VerificationTier;
  workspaceDir: string;
  writtenPaths: string[];
  commands?: Array<Pick<VerificationResult, "commandId" | "command" | "exitCode" | "timedOut" | "stdout" | "stderr">>;
  command?: Pick<VerificationResult, "commandId" | "command" | "exitCode" | "timedOut" | "stdout" | "stderr">;
  reason?: string;
}

const DEFAULT_COMMANDS: Record<VerificationCommandId, VerificationCommand> = {
  typecheck: { command: "npm", args: ["run", "typecheck"] },
  lint: { command: "npm", args: ["run", "lint"] },
  test: { command: "npm", args: ["test"] },
  build: { command: "npm", args: ["run", "build"] },
  smoke: { command: "npm", args: ["run", "smoke"] },
  e2e: { command: "npm", args: ["run", "e2e"] }
};

const MAX_OUTPUT_CHARS = 12_000;
const SENSITIVE_ENV_KEY_PATTERN = /(?:secret|token|password|passwd|credential|private|api[_-]?key|auth|cookie|session)/i;
const HOST_ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const;

export function createRunWorkspacePath(rootDir: string, forgeId: string, runId: string) {
  return path.join(rootDir, sanitizePathSegment(forgeId), sanitizePathSegment(runId));
}

export async function materializeVirtualFiles(workspaceDir: string, files: Pick<VirtualFile, "path" | "content">[]) {
  const root = path.resolve(workspaceDir);
  await mkdir(root, { recursive: true });

  const writtenPaths: string[] = [];
  for (const file of files) {
    const relativePath = normalizeVirtualPath(file.path);
    const absolutePath = path.resolve(root, relativePath);
    if (!isPathInside(root, absolutePath)) {
      throw new Error("Virtual file path escapes workspace.");
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
    writtenPaths.push(relativePath);
  }

  return { workspaceDir: root, writtenPaths };
}

export async function verifyGeneratedFiles(input: {
  workspaceRoot: string;
  forgeId: string;
  runId: string;
  files: Pick<VirtualFile, "path" | "content">[];
  commandId?: VerificationCommandId;
  tier?: VerificationTier;
  timeoutMs?: number;
}): Promise<AutomaticVerificationSummary> {
  const tier = input.tier ?? "development";
  const workspaceDir = createRunWorkspacePath(input.workspaceRoot, input.forgeId, input.runId);
  const materialized = await materializeVirtualFiles(workspaceDir, input.files);
  const packageFile = input.files.find((file) => normalizeVirtualPath(file.path) === "package.json");
  if (!packageFile) {
    return {
      status: "skipped",
      tier,
      workspaceDir: "[sandbox]",
      writtenPaths: materialized.writtenPaths,
      reason: "package.json was not generated, so no package test command was run."
    };
  }

  const packageScripts = readPackageScripts(packageFile.content);
  const commands = buildVerificationCommands(packageScripts, tier, input.commandId);
  if (commands.length === 0) {
    return {
      status: "skipped",
      tier,
      workspaceDir: "[sandbox]",
      writtenPaths: materialized.writtenPaths,
      reason: `No ${tier} verification scripts were available in package.json.`
    };
  }

  const results: VerificationResult[] = [];
  for (const commandId of commands) {
    const result = await runVerificationCommand(materialized.workspaceDir, commandId, { timeoutMs: input.timeoutMs });
    results.push(result);
    if (result.exitCode !== 0 || result.timedOut) {
      break;
    }
  }
  const failed = results.find((result) => result.exitCode !== 0 || result.timedOut);
  return {
    status: failed ? "failed" : "passed",
    tier,
    workspaceDir: "[sandbox]",
    writtenPaths: materialized.writtenPaths,
    commands: results,
    command: failed ?? results.at(-1)
  };
}

export async function runVerificationCommand(
  workspaceDir: string,
  commandId: string,
  options: {
    commands?: Partial<Record<string, VerificationCommand>>;
    timeoutMs?: number;
  } = {}
): Promise<VerificationResult> {
  const command = options.commands?.[commandId] ?? DEFAULT_COMMANDS[commandId as VerificationCommandId];
  if (!command) {
    throw new Error("Verification command is not allowlisted");
  }

  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000);
  const sandboxPaths = await getSandboxOutputAliases(workspaceDir);
  const sensitiveValues = getSensitiveOutputValues(process.env);
  const env = createVerificationEnvironment(process.env, workspaceDir);
  await prepareVerificationEnvironmentDirs(env);

  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: workspaceDir,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        commandId,
        command: formatCommand(command),
        exitCode: 127,
        timedOut,
        stdout: "",
        stderr: sanitizeOutput(error.message, sandboxPaths, sensitiveValues)
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        commandId,
        command: formatCommand(command),
        exitCode,
        timedOut,
        stdout: sanitizeOutput(stdout, sandboxPaths, sensitiveValues),
        stderr: sanitizeOutput(stderr, sandboxPaths, sensitiveValues)
      });
    });
  });
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120) || "unknown";
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function appendOutput(current: string, next: string) {
  return `${current}${next}`.slice(-MAX_OUTPUT_CHARS);
}

export async function getSandboxOutputAliases(workspaceDir: string) {
  const aliases = new Set([workspaceDir, path.resolve(workspaceDir)]);
  try {
    aliases.add(await realpath(workspaceDir));
  } catch {
    // The spawn call will surface missing workspace errors; path redaction is best-effort.
  }
  return [...aliases].filter(Boolean).sort((left, right) => right.length - left.length);
}

export function createVerificationEnvironment(hostEnv: NodeJS.ProcessEnv, workspaceDir: string) {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: hostEnv.NODE_ENV ?? "production"
  };
  for (const key of HOST_ENV_ALLOWLIST) {
    if (hostEnv[key]) {
      env[key] = hostEnv[key];
    }
  }

  const localHome = path.join(workspaceDir, ".home");
  env.HOME = localHome;
  env.USERPROFILE = localHome;
  env.TMPDIR = path.join(workspaceDir, ".tmp");
  env.TEMP = env.TMPDIR;
  env.TMP = env.TMPDIR;
  env.NODE_DISABLE_COMPILE_CACHE = "1";
  env.npm_config_cache = path.join(workspaceDir, ".npm-cache");
  env.npm_config_fund = "false";
  env.npm_config_audit = "false";
  env.npm_config_update_notifier = "false";

  return env;
}

export async function prepareVerificationEnvironmentDirs(env: NodeJS.ProcessEnv) {
  await Promise.all([env.HOME, env.TMPDIR, env.npm_config_cache].filter(Boolean).map((dir) => mkdir(dir as string, { recursive: true })));
}

export function getSensitiveOutputValues(hostEnv: NodeJS.ProcessEnv) {
  return Object.entries(hostEnv)
    .filter(([key, value]) => SENSITIVE_ENV_KEY_PATTERN.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

export function sanitizeOutput(value: string, sandboxPaths: string[], sensitiveValues: string[]) {
  const redactedSecrets = sensitiveValues.reduce((output, sensitiveValue) => output.replaceAll(sensitiveValue, "[redacted]"), value);
  return sandboxPaths
    .reduce((output, sandboxPath) => output.replaceAll(sandboxPath, "[sandbox]"), redactedSecrets)
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [redacted]")
    .slice(-MAX_OUTPUT_CHARS);
}

function formatCommand(command: VerificationCommand) {
  return [command.command, ...command.args].join(" ");
}

export function readPackageScripts(content: string) {
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    if (!parsed.scripts || typeof parsed.scripts !== "object") {
      return new Set<string>();
    }
    return new Set(Object.entries(parsed.scripts).filter(([, value]) => typeof value === "string" && value.trim().length > 0).map(([key]) => key));
  } catch {
    return new Set<string>();
  }
}

export function buildVerificationCommands(scripts: Set<string>, tier: VerificationTier, requestedCommandId?: VerificationCommandId) {
  if (requestedCommandId) {
    return [requestedCommandId].filter((commandId) => scripts.has(commandId));
  }

  if (tier === "development") {
    return ["test", "typecheck", "lint"].filter((commandId) => scripts.has(commandId));
  }

  return ["test", "typecheck", "lint", "build", "smoke", "e2e"].filter((commandId) => scripts.has(commandId));
}
