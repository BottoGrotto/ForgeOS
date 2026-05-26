import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunWorkspacePath, materializeVirtualFiles, runVerificationCommand, verifyGeneratedFiles } from "./execution";

let tempDirs: string[] = [];

describe("runtime execution helpers", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("creates sanitized per-run workspace paths", async () => {
    const root = await createTempDir();

    expect(createRunWorkspacePath(root, "forge/../one", "run:one")).toBe(path.join(root, "forge-..-one", "run-one"));
  });

  it("materializes virtual files inside the run workspace", async () => {
    const workspace = await createTempDir();

    const result = await materializeVirtualFiles(workspace, [
      { path: "src/app/page.tsx", content: "export default function Page() { return null; }" },
      { path: "./README.md", content: "# Generated" }
    ]);

    await expect(readFile(path.join(workspace, "src/app/page.tsx"), "utf8")).resolves.toContain("Page");
    await expect(readFile(path.join(workspace, "README.md"), "utf8")).resolves.toBe("# Generated");
    expect(result.writtenPaths).toEqual(["src/app/page.tsx", "README.md"]);
  });

  it("rejects virtual file paths that escape or target unsafe locations", async () => {
    const workspace = await createTempDir();

    await expect(materializeVirtualFiles(workspace, [{ path: "../outside.ts", content: "" }])).rejects.toThrow("Invalid virtual file path");
    await expect(materializeVirtualFiles(workspace, [{ path: "/tmp/outside.ts", content: "" }])).rejects.toThrow("Invalid virtual file path");
    await expect(materializeVirtualFiles(workspace, [{ path: "safe/../../outside.ts", content: "" }])).rejects.toThrow("Invalid virtual file path");
  });

  it("runs an allowlisted verification command and sanitizes output", async () => {
    const workspace = await createTempDir();
    const result = await runVerificationCommand(workspace, "test", {
      commands: {
        test: {
          command: process.execPath,
          args: ["-e", "console.log('ok sk-secret123 ' + process.cwd()); console.error('Bearer token123 ' + process.cwd());"]
        }
      },
      timeoutMs: 5_000
    });

    expect(result).toMatchObject({
      commandId: "test",
      exitCode: 0,
      timedOut: false
    });
    expect(result.stdout).toContain("ok [redacted]");
    expect(result.stderr).toContain("Bearer [redacted]");
    expect(result.stdout).toContain("[sandbox]");
    expect(result.stderr).toContain("[sandbox]");
    expect(result.stdout).not.toContain(workspace);
    expect(result.stderr).not.toContain(workspace);
  });

  it("does not expose host secrets to generated verification scripts and redacts secret output values", async () => {
    const workspace = await createTempDir();
    const sensitiveValue = "forgeos-host-sensitive-fixture";
    process.env.FORGEOS_FAKE_HOST_SECRET = sensitiveValue;

    try {
      const result = await runVerificationCommand(workspace, "test", {
        commands: {
          test: {
            command: process.execPath,
            args: [
              "-e",
              [
                "console.log('env:' + (process.env.FORGEOS_FAKE_HOST_SECRET ?? 'missing'));",
                `console.log('literal:${sensitiveValue}');`,
                "console.log('home:' + process.env.HOME);"
              ].join("")
            ]
          }
        },
        timeoutMs: 5_000
      });

      expect(result).toMatchObject({
        commandId: "test",
        exitCode: 0,
        timedOut: false
      });
      expect(result.stdout).toContain("env:missing");
      expect(result.stdout).toContain("literal:[redacted]");
      expect(result.stdout).toContain("home:[sandbox]");
      expect(result.stdout).not.toContain(sensitiveValue);
    } finally {
      delete process.env.FORGEOS_FAKE_HOST_SECRET;
    }
  });

  it("rejects verification commands outside the allowlist", async () => {
    const workspace = await createTempDir();

    await expect(runVerificationCommand(workspace, "publish" as "test", { commands: {} })).rejects.toThrow("Verification command is not allowlisted");
  });

  it("does not execute provider-requested commands that are not runtime-owned verification checks", async () => {
    const workspace = await createTempDir();
    const sentinelPath = path.join(workspace, "dangerous-command-ran");

    await expect(
      runVerificationCommand(workspace, "provider-requested-shell" as "test", {
        commands: {
          test: {
            command: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'executed')`]
          }
        }
      })
    ).rejects.toThrow("Verification command is not allowlisted");
    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
  });

  it("skips automatic package verification when generated files have no package manifest", async () => {
    const workspaceRoot = await createTempDir();

    const summary = await verifyGeneratedFiles({
      workspaceRoot,
      forgeId: "forge-1",
      runId: "run-1",
      files: [{ path: "src/index.ts", content: "export const value = 1;" }]
    });

    expect(summary).toMatchObject({
      status: "skipped",
      workspaceDir: "[sandbox]",
      writtenPaths: ["src/index.ts"]
    });
  });

  it("runs development verification across test, typecheck, and lint when available", async () => {
    const workspaceRoot = await createTempDir();

    const summary = await verifyGeneratedFiles({
      workspaceRoot,
      forgeId: "forge-dev",
      runId: "run-dev",
      tier: "development",
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            scripts: {
              test: `${process.execPath} -e "console.log('dev test')"`,
              typecheck: `${process.execPath} -e "console.log('dev typecheck')"`,
              lint: `${process.execPath} -e "console.log('dev lint')"`,
              build: `${process.execPath} -e "require('node:fs').writeFileSync('build-ran', 'yes')"`
            }
          })
        }
      ],
      timeoutMs: 5_000
    });

    expect(summary).toMatchObject({
      status: "passed",
      tier: "development",
      commands: [
        {
          commandId: "test",
          exitCode: 0
        },
        {
          commandId: "typecheck",
          exitCode: 0
        },
        {
          commandId: "lint",
          exitCode: 0
        }
      ]
    });
    await expect(readFile(path.join(workspaceRoot, "forge-dev", "run-dev", "build-ran"), "utf8")).rejects.toThrow();
  });

  it("runs an acceptance verification tier across available package checks", async () => {
    const workspaceRoot = await createTempDir();

    const summary = await verifyGeneratedFiles({
      workspaceRoot,
      forgeId: "forge-accept",
      runId: "run-accept",
      tier: "acceptance",
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            scripts: {
              test: `${process.execPath} -e "console.log('accept test')"`,
              build: `${process.execPath} -e "console.error('accept build failed'); process.exit(1)"`
            }
          })
        }
      ],
      timeoutMs: 5_000
    });

    expect(summary).toMatchObject({
      status: "failed",
      tier: "acceptance",
      commands: [
        {
          commandId: "test",
          exitCode: 0
        },
        {
          commandId: "build",
          exitCode: 1
        }
      ]
    });
    expect(summary.command?.commandId).toBe("build");
    expect(summary.command?.stderr).toContain("accept build failed");
  });
});

async function createTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forgeos-execution-"));
  tempDirs.push(dir);
  return dir;
}
