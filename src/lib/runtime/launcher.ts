import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  buildVerificationCommands,
  createVerificationEnvironment,
  getSandboxOutputAliases,
  getSensitiveOutputValues,
  materializeVirtualFiles,
  prepareVerificationEnvironmentDirs,
  readPackageScripts,
  runVerificationCommand,
  sanitizeOutput,
  type VerificationCommandId,
  type VerificationTier
} from "./execution";
import type { ForgeSnapshot, RuntimeEventDraft, VirtualFile } from "./types";

export type LauncherTier = VerificationTier;
export type LauncherScript = "auto" | VerificationCommandId;
export type PreviewScript = "auto" | "dev" | "start" | "preview";

interface LauncherOptions {
  workspaceRoot: string;
  launcherId: string;
  timeoutMs?: number;
}

interface ProjectCheckOptions extends LauncherOptions {
  tier: LauncherTier;
  script: LauncherScript;
}

interface ProjectPreviewOptions extends LauncherOptions {
  script: PreviewScript;
  readinessTimeoutMs?: number;
}

interface StopPreviewOptions {
  launcherId: string;
}

interface ActivePreview {
  launcherId: string;
  forgeId: string;
  child: ChildProcess;
  url: string;
  command: string;
  startedAt: string;
  logs: string;
}

const PREVIEW_COMMANDS: Record<Exclude<PreviewScript, "auto">, { command: string; args: string[] }> = {
  dev: { command: "npm", args: ["run", "dev"] },
  start: { command: "npm", args: ["run", "start"] },
  preview: { command: "npm", args: ["run", "preview"] }
};
const STATIC_PREVIEW_SCRIPT = `
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = process.cwd();
const port = Number(process.env.PORT || 3000);
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"]
]);
function targetPath(url) {
  const rawPath = decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
  const relative = rawPath === "/" ? "index.html" : rawPath.replace(/^\\/+/, "");
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(root + path.sep) || resolved === root ? resolved : path.join(root, "index.html");
}
http.createServer(async (req, res) => {
  try {
    const filePath = targetPath(req.url || "/");
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": types.get(path.extname(filePath).toLowerCase()) || "application/octet-stream" });
    res.end(data);
  } catch {
    try {
      const data = await fs.readFile(path.join(root, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  }
}).listen(port, "127.0.0.1", () => console.log("Static preview ready on http://127.0.0.1:" + port));
`;

const DEFAULT_WORKSPACE_ROOT = path.join(process.cwd(), ".forgeos", "launchers");
const activePreviews = new Map<string, ActivePreview>();
const MAX_LOG_CHARS = 12_000;

export function createLauncherId() {
  return `launcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createLauncherWorkspacePath(rootDir: string, forgeSlug: string, launcherId: string) {
  return path.join(rootDir, sanitizePathSegment(forgeSlug), sanitizePathSegment(launcherId));
}

export function detectLauncherPackageScripts(files: Array<Pick<VirtualFile, "path" | "content">>) {
  const packageFile = findPackageFile(selectLauncherWorkspaceFiles(files));
  if (!packageFile) {
    return new Set<string>();
  }
  return new Set([...readPackageScripts(packageFile.content)].sort());
}

export function chooseLauncherCheckCommands(scripts: Set<string>, tier: LauncherTier, script: LauncherScript) {
  return buildVerificationCommands(scripts, tier, script === "auto" ? undefined : script);
}

export function choosePreviewScript(scripts: Set<string>, script: PreviewScript) {
  if (script !== "auto") {
    return scripts.has(script) ? script : undefined;
  }
  return (["dev", "start", "preview"] as const).find((candidate) => scripts.has(candidate));
}

function shouldUseStaticPreview(writtenPaths: string[], requestedScript: PreviewScript) {
  if (requestedScript !== "auto" && requestedScript !== "dev") {
    return false;
  }
  const paths = new Set(writtenPaths.map((filePath) => filePath.replace(/^\.\//, "")));
  return paths.has("index.html") && writtenPaths.some((filePath) => /\.(css|js|mjs|png|jpe?g|svg|webp|ico)$/i.test(filePath));
}

export async function runProjectCheck(snapshot: ForgeSnapshot, options: ProjectCheckOptions) {
  const materialized = await materializeLauncherFiles(snapshot, options.workspaceRoot, options.launcherId);
  const launcherFiles = selectLauncherWorkspaceFiles(snapshot.files);
  const packageFile = findPackageFile(launcherFiles);
  const baseEvents = [createMaterializedEvent(snapshot, options.launcherId, materialized.workspaceDir, materialized.writtenPaths)];

  if (!packageFile) {
    return {
      events: [
        ...baseEvents,
        createCheckCompletedEvent(snapshot, options.launcherId, "skipped", options.tier, {
          reason: "package.json is required before launcher checks can run."
        })
      ]
    };
  }

  const scripts = readPackageScripts(packageFile.content);
  const commandIds = chooseLauncherCheckCommands(scripts, options.tier, options.script);
  if (commandIds.length === 0) {
    return {
      events: [
        ...baseEvents,
        createCheckCompletedEvent(snapshot, options.launcherId, "skipped", options.tier, {
          reason: `No ${options.tier} launcher scripts matched the request.`,
          availableScripts: [...scripts].sort()
        })
      ]
    };
  }

  const install = await ensureDependenciesInstalled(snapshot, options.launcherId, materialized.workspaceDir, packageFile.content, options.timeoutMs);
  const startedEvent = createCheckStartedEvent(snapshot, options.launcherId, options.tier, commandIds);
  if (install.result && (install.result.exitCode !== 0 || install.result.timedOut)) {
    return {
      events: [
        ...baseEvents,
        install.event!,
        startedEvent,
        createCheckCompletedEvent(snapshot, options.launcherId, "failed", options.tier, {
          commandIds,
          command: install.result.command,
          exitCode: install.result.exitCode,
          timedOut: install.result.timedOut,
          reason: "Dependency installation failed."
        }),
        createLogEvent(snapshot, options.launcherId, [install.result.stdout, install.result.stderr].filter(Boolean).join("\n"))
      ]
    };
  }
  const commandResults = [];
  for (const commandId of commandIds) {
    const result = await runVerificationCommand(materialized.workspaceDir, commandId, { timeoutMs: options.timeoutMs });
    commandResults.push(result);
    if (result.exitCode !== 0 || result.timedOut) {
      break;
    }
  }

  const failed = commandResults.find((result) => result.exitCode !== 0 || result.timedOut);
  const status = failed ? "failed" : "passed";
  const tail = [...(install.result ? [install.result] : []), ...commandResults]
    .map((result) => [result.stdout, result.stderr].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n")
    .slice(-MAX_LOG_CHARS);

  return {
    events: [
      ...baseEvents,
      ...(install.event ? [install.event] : []),
      startedEvent,
      createCheckCompletedEvent(snapshot, options.launcherId, status, options.tier, {
        commandIds,
        command: failed?.command ?? commandResults.at(-1)?.command,
        exitCode: failed?.exitCode ?? commandResults.at(-1)?.exitCode,
        timedOut: Boolean(failed?.timedOut)
      }),
      createLogEvent(snapshot, options.launcherId, tail || "Launcher check completed.")
    ]
  };
}

export async function startProjectPreview(snapshot: ForgeSnapshot, options: ProjectPreviewOptions) {
  if (activePreviews.has(options.launcherId)) {
    const preview = activePreviews.get(options.launcherId)!;
    return {
      events: [createPreviewReadyEvent(snapshot, options.launcherId, preview.url, preview.command, { reused: true })]
    };
  }

  const materialized = await materializeLauncherFiles(snapshot, options.workspaceRoot, options.launcherId);
  const launcherFiles = selectLauncherWorkspaceFiles(snapshot.files);
  const packageFile = findPackageFile(launcherFiles);
  const baseEvents = [createMaterializedEvent(snapshot, options.launcherId, materialized.workspaceDir, materialized.writtenPaths)];
  if (!packageFile) {
    return {
      events: [
        ...baseEvents,
        createPreviewFailedEvent(snapshot, options.launcherId, "package.json is required before launcher previews can start.")
      ]
    };
  }

  const scripts = readPackageScripts(packageFile.content);
  const staticPreview = shouldUseStaticPreview(materialized.writtenPaths, options.script);
  const script = staticPreview ? undefined : choosePreviewScript(scripts, options.script);
  if (!staticPreview && !script) {
    return {
      events: [
        ...baseEvents,
        createPreviewFailedEvent(snapshot, options.launcherId, "No preview script matched the request.", { availableScripts: [...scripts].sort() })
      ]
    };
  }

  const install = staticPreview
    ? ({ installed: false } as Awaited<ReturnType<typeof ensureDependenciesInstalled>>)
    : await ensureDependenciesInstalled(snapshot, options.launcherId, materialized.workspaceDir, packageFile.content, options.timeoutMs);
  if (install.result && (install.result.exitCode !== 0 || install.result.timedOut)) {
    return {
      events: [
        ...baseEvents,
        install.event!,
        createPreviewFailedEvent(snapshot, options.launcherId, "Dependency installation failed.", { command: install.result.command, exitCode: install.result.exitCode }),
        createLogEvent(snapshot, options.launcherId, [install.result.stdout, install.result.stderr].filter(Boolean).join("\n"))
      ]
    };
  }
  const port = await findAvailableLocalPort();
  const env = createVerificationEnvironment(process.env, materialized.workspaceDir);
  env.HOST = "127.0.0.1";
  env.HOSTNAME = "127.0.0.1";
  env.PORT = String(port);
  await prepareVerificationEnvironmentDirs(env);
  const sandboxPaths = await getSandboxOutputAliases(materialized.workspaceDir);
  const sensitiveValues = getSensitiveOutputValues(process.env);
  const previewCommand = staticPreview ? { command: process.execPath, args: ["-e", STATIC_PREVIEW_SCRIPT] } : PREVIEW_COMMANDS[script!];
  const startedAt = new Date().toISOString();
  const child = spawn(previewCommand.command, previewCommand.args, {
    cwd: materialized.workspaceDir,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const url = `http://127.0.0.1:${port}`;
  const preview: ActivePreview = {
    launcherId: options.launcherId,
    forgeId: snapshot.forge.id,
    child,
    url,
    command: staticPreview ? "ForgeOS static preview server" : formatCommand(previewCommand),
    startedAt,
    logs: ""
  };
  activePreviews.set(options.launcherId, preview);

  child.stdout.on("data", (chunk) => {
    preview.logs = appendOutput(preview.logs, sanitizeOutput(String(chunk), sandboxPaths, sensitiveValues));
  });
  child.stderr.on("data", (chunk) => {
    preview.logs = appendOutput(preview.logs, sanitizeOutput(String(chunk), sandboxPaths, sensitiveValues));
  });
  child.on("close", (exitCode) => {
    if (activePreviews.get(options.launcherId)?.child === child) {
      activePreviews.delete(options.launcherId);
    }
    preview.logs = appendOutput(preview.logs, `\nPreview exited with code ${exitCode ?? "unknown"}.`);
  });

  const startup = await waitForPreviewReady(url, child, options.readinessTimeoutMs ?? 20_000);
  if (!startup.ready) {
    activePreviews.delete(options.launcherId);
    child.kill("SIGTERM");
    return {
      events: [
        ...baseEvents,
        ...(install.event ? [install.event] : []),
        createPreviewStartedEvent(snapshot, options.launcherId, preview.command, port),
        createPreviewFailedEvent(snapshot, options.launcherId, startup.reason, { command: preview.command }),
        createLogEvent(snapshot, options.launcherId, preview.logs || startup.reason)
      ]
    };
  }

  return {
    events: [
      ...baseEvents,
      ...(install.event ? [install.event] : []),
      createPreviewStartedEvent(snapshot, options.launcherId, preview.command, port),
      createPreviewReadyEvent(snapshot, options.launcherId, url, preview.command),
      createLogEvent(snapshot, options.launcherId, preview.logs || `Preview ready at ${url}.`)
    ]
  };
}

export async function stopProjectPreview(snapshot: ForgeSnapshot, options: StopPreviewOptions) {
  const preview = activePreviews.get(options.launcherId);
  if (!preview) {
    return {
      events: [
        {
          forgeId: snapshot.forge.id,
          type: "launcher.preview_stopped",
          actorType: "runtime",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "No active preview was registered for this launcher.",
          severity: "info",
          payload: { launcherId: options.launcherId, stopReason: "not_running" }
        } satisfies RuntimeEventDraft
      ]
    };
  }

  activePreviews.delete(options.launcherId);
  preview.child.kill("SIGTERM");
  await waitForChildExit(preview.child, 2_000);
  return {
    events: [
      {
        forgeId: snapshot.forge.id,
        type: "launcher.preview_stopped",
        actorType: "runtime",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message: "Project preview stopped.",
        severity: "success",
        payload: { launcherId: options.launcherId, url: preview.url, stopReason: "operator_requested" }
      } satisfies RuntimeEventDraft
    ]
  };
}

function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const forceTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const giveUpTimer = setTimeout(resolve, timeoutMs + 1_000);
    child.once("close", () => {
      clearTimeout(forceTimer);
      clearTimeout(giveUpTimer);
      resolve();
    });
  });
}

export function getDefaultLauncherWorkspaceRoot() {
  return process.env.FORGEOS_LAUNCHER_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT;
}

export async function stopForgePreviews(forgeId: string) {
  const previews = Array.from(activePreviews.values()).filter((preview) => preview.forgeId === forgeId);
  await Promise.all(
    previews.map(async (preview) => {
      activePreviews.delete(preview.launcherId);
      preview.child.kill("SIGTERM");
      await waitForChildExit(preview.child, 2_000);
    })
  );
}

async function materializeLauncherFiles(snapshot: ForgeSnapshot, workspaceRoot: string, launcherId: string) {
  const workspaceDir = createLauncherWorkspacePath(workspaceRoot, snapshot.forge.slug, launcherId);
  return materializeVirtualFiles(workspaceDir, selectLauncherWorkspaceFiles(snapshot.files));
}

function selectLauncherWorkspaceFiles(files: Array<Pick<VirtualFile, "path" | "content"> & Partial<Pick<VirtualFile, "id" | "version" | "updatedAt">>>) {
  const byPath = new Map<string, Pick<VirtualFile, "path" | "content">>();
  for (const file of files.slice().sort(compareLauncherFilePriority)) {
    const normalizedPath = file.path.replace(/^\.\//, "");
    if (!byPath.has(normalizedPath)) {
      byPath.set(normalizedPath, file);
    }
  }
  return Array.from(byPath.values());
}

function compareLauncherFilePriority(
  left: Pick<VirtualFile, "path"> & Partial<Pick<VirtualFile, "id" | "version" | "updatedAt">>,
  right: Pick<VirtualFile, "path"> & Partial<Pick<VirtualFile, "id" | "version" | "updatedAt">>
) {
  return (
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
    (right.version ?? 0) - (left.version ?? 0) ||
    left.path.localeCompare(right.path) ||
    (left.id ?? left.path).localeCompare(right.id ?? right.path)
  );
}

async function ensureDependenciesInstalled(snapshot: ForgeSnapshot, launcherId: string, workspaceDir: string, packageContent: string, timeoutMs?: number) {
  const dependencies = getPackageDependencies(packageContent);
  if (dependencies.length === 0 || (await pathExists(path.join(workspaceDir, "node_modules")))) {
    return { installed: false };
  }

  const result = await runVerificationCommand(workspaceDir, "install_dependencies", {
    commands: {
      install_dependencies: {
        command: "npm",
        args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"]
      }
    },
    timeoutMs: timeoutMs ?? 120_000
  });

  return {
    installed: result.exitCode === 0 && !result.timedOut,
    result,
    event: {
      forgeId: snapshot.forge.id,
      type: "launcher.log",
      actorType: "runtime",
      targetType: "forge",
      targetId: snapshot.forge.id,
      message: "Launcher dependency install completed.",
      severity: result.exitCode === 0 && !result.timedOut ? "info" : "warning",
      payload: {
        launcherId,
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr
      }
    } satisfies RuntimeEventDraft
  };
}

function findPackageFile(files: Array<Pick<VirtualFile, "path" | "content">>) {
  return files.find((file) => file.path.replace(/^\.\//, "") === "package.json");
}

function getPackageDependencies(content: string) {
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    return [parsed.dependencies, parsed.devDependencies, parsed.optionalDependencies]
      .flatMap((entry) => (entry ? Object.keys(entry) : []))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function pathExists(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findAvailableLocalPort() {
  return new Promise<number>((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Unable to allocate a local preview port."));
        }
      });
    });
  });
}

async function waitForPreviewReady(url: string, child: ChildProcess, timeoutMs: number): Promise<{ ready: true } | { ready: false; reason: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.killed) {
      return { ready: false, reason: "Preview process exited before it became ready." };
    }
    const probe = await probePreview(url);
    if (probe.ready) {
      return { ready: true };
    }
    if (probe.reason) {
      return { ready: false, reason: probe.reason };
    }
    await delay(150);
  }
  return { ready: false, reason: "Preview readiness timed out." };
}

async function probePreview(url: string): Promise<{ ready: true } | { ready: false; reason?: string }> {
  const root = await fetchPreviewAsset(url);
  if (!root.ok) {
    return { ready: false };
  }
  const stylesheetHrefs = findStylesheetHrefs(root.body);
  for (const href of stylesheetHrefs) {
    const asset = await fetchPreviewAsset(new URL(href, url).toString());
    const contentType = asset.headers["content-type"] ?? "";
    if (!asset.ok || /text\/html/i.test(contentType)) {
      return { ready: false, reason: `Preview stylesheet did not load correctly: ${href}` };
    }
  }
  return { ready: true };
}

async function fetchPreviewAsset(url: string) {
  return new Promise<{ ok: boolean; statusCode?: number; headers: http.IncomingHttpHeaders; body: string }>((resolve) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body = appendOutput(body, String(chunk));
      });
      response.on("end", () => {
        resolve({
          ok: Boolean(response.statusCode && response.statusCode < 500),
          statusCode: response.statusCode,
          headers: response.headers,
          body
        });
      });
    });
    request.on("error", () => resolve({ ok: false, headers: {}, body: "" }));
    request.setTimeout(1_000, () => {
      request.destroy();
      resolve({ ok: false, headers: {}, body: "" });
    });
  });
}

function findStylesheetHrefs(html: string) {
  return Array.from(html.matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi))
    .flatMap((match) => {
      const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
      return href ? [href] : [];
    })
    .slice(0, 20);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendOutput(current: string, next: string) {
  return `${current}${next}`.slice(-MAX_LOG_CHARS);
}

function formatCommand(command: { command: string; args: string[] }) {
  return [command.command, ...command.args].join(" ");
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120) || "unknown";
}

function createMaterializedEvent(snapshot: ForgeSnapshot, launcherId: string, workspaceDir: string, writtenPaths: string[]): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "launcher.materialized",
    actorType: "runtime",
    targetType: "forge",
    targetId: snapshot.forge.id,
    message: "Virtual files materialized for launcher execution.",
    severity: "info",
    payload: { launcherId, workspaceDir: "[sandbox]", writtenPaths }
  };
}

function createCheckStartedEvent(snapshot: ForgeSnapshot, launcherId: string, tier: LauncherTier, commandIds: string[]): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "launcher.check_started",
    actorType: "runtime",
    targetType: "forge",
    targetId: snapshot.forge.id,
    message: "Project launcher check started.",
    severity: "info",
    payload: { launcherId, tier, commandIds }
  };
}

function createCheckCompletedEvent(snapshot: ForgeSnapshot, launcherId: string, status: "passed" | "failed" | "skipped", tier: LauncherTier, payload: Record<string, unknown>): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "launcher.check_completed",
    actorType: "runtime",
    targetType: "forge",
    targetId: snapshot.forge.id,
    message: status === "passed" ? "Project launcher check passed." : status === "failed" ? "Project launcher check failed." : "Project launcher check skipped.",
    severity: status === "passed" ? "success" : status === "failed" ? "error" : "warning",
    payload: { launcherId, status, tier, ...payload }
  };
}

function createPreviewStartedEvent(snapshot: ForgeSnapshot, launcherId: string, command: string, port: number): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "launcher.preview_started",
    actorType: "runtime",
    targetType: "forge",
    targetId: snapshot.forge.id,
    message: "Project preview process started.",
    severity: "info",
    payload: { launcherId, command, port }
  };
}

function createPreviewReadyEvent(snapshot: ForgeSnapshot, launcherId: string, url: string, command: string, extra: Record<string, unknown> = {}): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "launcher.preview_ready",
    actorType: "runtime",
    targetType: "forge",
    targetId: snapshot.forge.id,
    message: "Project preview is ready.",
    severity: "success",
    payload: { launcherId, url, command, ...extra }
  };
}

function createPreviewFailedEvent(snapshot: ForgeSnapshot, launcherId: string, reason: string, extra: Record<string, unknown> = {}): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "launcher.preview_failed",
    actorType: "runtime",
    targetType: "forge",
    targetId: snapshot.forge.id,
    message: reason,
    severity: "error",
    payload: { launcherId, reason, ...extra }
  };
}

function createLogEvent(snapshot: ForgeSnapshot, launcherId: string, output: string): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "launcher.log",
    actorType: "runtime",
    targetType: "forge",
    targetId: snapshot.forge.id,
    message: "Launcher log tail captured.",
    severity: "info",
    payload: { launcherId, output: output.slice(-MAX_LOG_CHARS) }
  };
}
