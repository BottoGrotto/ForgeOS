import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createForgeSnapshot } from "@/lib/mock/seed";
import type { ForgeSnapshot } from "./types";
import {
  chooseLauncherCheckCommands,
  createLauncherId,
  detectLauncherPackageScripts,
  runProjectCheck,
  startProjectPreview,
  stopProjectPreview
} from "./launcher";

let tempDirs: string[] = [];

describe("runtime launcher service", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("detects package scripts and chooses development versus acceptance checks", () => {
    const scripts = detectLauncherPackageScripts([
      {
        path: "package.json",
        content: JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc", build: "next build", dev: "next dev" } })
      }
    ]);

    expect([...scripts]).toEqual(["build", "dev", "test", "typecheck"]);
    expect(chooseLauncherCheckCommands(scripts, "development", "auto")).toEqual(["test", "typecheck"]);
    expect(chooseLauncherCheckCommands(scripts, "acceptance", "auto")).toEqual(["test", "typecheck", "build"]);
    expect(chooseLauncherCheckCommands(scripts, "development", "lint")).toEqual([]);
  });

  it("runs a project check and emits sanitized launcher events", async () => {
    const workspaceRoot = await createTempDir();
    const sensitiveValue = "forgeos-launcher-sensitive-fixture";
    process.env.FORGEOS_FAKE_LAUNCHER_TOKEN = sensitiveValue;

    try {
      const snapshot = withFiles([
        {
          path: "package.json",
          content: JSON.stringify({
            scripts: {
              test: `${process.execPath} -e "console.log('sensitive:${sensitiveValue}'); console.error('cwd:' + process.cwd())"`
            }
          })
        }
      ]);

      const result = await runProjectCheck(snapshot, {
        workspaceRoot,
        launcherId: "check-one",
        tier: "development",
        script: "auto",
        timeoutMs: 5_000
      });

      expect(result.events.map((event) => event.type)).toEqual([
        "launcher.materialized",
        "launcher.check_started",
        "launcher.check_completed",
        "launcher.log"
      ]);
      expect(result.events.find((event) => event.type === "launcher.check_completed")?.payload).toMatchObject({
        launcherId: "check-one",
        status: "passed",
        commandIds: ["test"]
      });
      expect(JSON.stringify(result.events)).not.toContain(sensitiveValue);
      expect(JSON.stringify(result.events)).not.toContain(workspaceRoot);
      expect(JSON.stringify(result.events)).toContain("[redacted]");
      expect(JSON.stringify(result.events)).toContain("[sandbox]");
    } finally {
      delete process.env.FORGEOS_FAKE_LAUNCHER_TOKEN;
    }
  });

  it("materializes the latest full virtual workspace so previews can load stylesheets", async () => {
    const workspaceRoot = await createTempDir();
    const snapshot = withVirtualFiles([
      virtualFile("old-package", "package.json", JSON.stringify({ scripts: { dev: "old" } }), "2026-05-17T00:00:00.000Z", 1),
      virtualFile("new-package", "package.json", JSON.stringify({ scripts: { dev: "new" } }), "2026-05-18T00:00:00.000Z", 2),
      virtualFile("page", "app/page.tsx", "import '../styles/globals.css';\nexport default function Page(){return <main className='game'>Ready</main>}", "2026-05-18T00:00:00.000Z", 1),
      virtualFile("style", "styles/globals.css", ".game { color: rgb(0, 255, 255); }", "2026-05-18T00:00:00.000Z", 1)
    ]);

    const result = await runProjectCheck(snapshot, {
      workspaceRoot,
      launcherId: "style-materialization",
      tier: "development",
      script: "auto",
      timeoutMs: 5_000
    });

    const materialized = result.events.find((event) => event.type === "launcher.materialized");
    expect((materialized?.payload as { writtenPaths?: string[] } | undefined)?.writtenPaths).toEqual(expect.arrayContaining(["package.json", "app/page.tsx", "styles/globals.css"]));
    await expect(readFile(path.join(workspaceRoot, snapshot.forge.slug, "style-materialization", "styles/globals.css"), "utf8")).resolves.toContain(".game");
    await expect(readFile(path.join(workspaceRoot, snapshot.forge.slug, "style-materialization", "package.json"), "utf8")).resolves.toContain("\"new\"");
  });

  it("skips project checks clearly when package.json is missing", async () => {
    const workspaceRoot = await createTempDir();
    const result = await runProjectCheck(withFiles([{ path: "src/index.ts", content: "export const value = 1;" }]), {
      workspaceRoot,
      launcherId: "missing-package",
      tier: "development",
      script: "auto",
      timeoutMs: 5_000
    });

    expect(result.events.map((event) => event.type)).toEqual(["launcher.materialized", "launcher.check_completed"]);
    expect(result.events.at(-1)).toMatchObject({
      severity: "warning",
      payload: {
        launcherId: "missing-package",
        status: "skipped",
        reason: "package.json is required before launcher checks can run."
      }
    });
  });

  it("starts a preview on a local port and stops it by launcher id", async () => {
    const workspaceRoot = await createTempDir();
    const launcherId = createLauncherId();
    const snapshot = withFiles([
      {
        path: "package.json",
        content: JSON.stringify({
          scripts: {
            dev: `${process.execPath} -e "const http=require('node:http'); const port=Number(process.env.PORT); http.createServer((_,res)=>res.end('ready')).listen(port, '127.0.0.1')"`
          }
        })
      }
    ]);

    const started = await startProjectPreview(snapshot, {
      workspaceRoot,
      launcherId,
      script: "dev",
      readinessTimeoutMs: 5_000
    });
    const ready = started.events.find((event) => event.type === "launcher.preview_ready");
    const readyPayload = ready?.payload as Record<string, unknown> | undefined;
    const url = typeof readyPayload?.url === "string" ? readyPayload.url : "";
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(fetch(url)).resolves.toMatchObject({ ok: true });

    const stopped = await stopProjectPreview(snapshot, { launcherId });
    expect(stopped.events.at(-1)).toMatchObject({
      type: "launcher.preview_stopped",
      severity: "success",
      payload: { launcherId, stopReason: "operator_requested" }
    });
  });

  it("serves static html workspaces with linked stylesheets through the launcher static server", async () => {
    const workspaceRoot = await createTempDir();
    const launcherId = createLauncherId();
    const snapshot = withFiles([
      {
        path: "package.json",
        content: JSON.stringify({
          scripts: {
            dev: `${process.execPath} -e "const http=require('node:http'); const fs=require('node:fs'); const port=Number(process.env.PORT); http.createServer((req,res)=>{ res.setHeader('content-type','text/html'); res.end(fs.readFileSync('index.html')); }).listen(port, '127.0.0.1')"`
          }
        })
      },
      {
        path: "index.html",
        content: "<!doctype html><html><head><link rel=\"stylesheet\" href=\"./styles.css\"></head><body><main class=\"ready\">Ready</main></body></html>"
      },
      {
        path: "styles.css",
        content: ".ready { color: rgb(1, 2, 3); }"
      }
    ]);

    const started = await startProjectPreview(snapshot, {
      workspaceRoot,
      launcherId,
      script: "auto",
      readinessTimeoutMs: 5_000
    });
    const ready = started.events.find((event) => event.type === "launcher.preview_ready");
    const readyPayload = ready?.payload as Record<string, unknown> | undefined;
    const url = typeof readyPayload?.url === "string" ? readyPayload.url : "";

    expect(readyPayload?.command).toBe("ForgeOS static preview server");
    const css = await fetch(`${url}/styles.css`);
    await expect(css.text()).resolves.toContain(".ready");
    expect(css.headers.get("content-type")).toContain("text/css");

    await stopProjectPreview(snapshot, { launcherId });
  });
});

function withFiles(files: Array<{ path: string; content: string }>): ForgeSnapshot {
  const snapshot = createForgeSnapshot({ id: "launcher-forge", slug: "launcher-forge", name: "Launcher Forge" });
  return withVirtualFiles(files.map((file, index) => virtualFile(`file-${index}`, file.path, file.content, new Date(0).toISOString(), 1)), snapshot);
}

function withVirtualFiles(files: ForgeSnapshot["files"], inputSnapshot = createForgeSnapshot({ id: "launcher-forge", slug: "launcher-forge", name: "Launcher Forge" })): ForgeSnapshot {
  return {
    ...inputSnapshot,
    files
  };
}

function virtualFile(id: string, filePath: string, content: string, updatedAt: string, version: number): ForgeSnapshot["files"][number] {
  return {
    id,
    path: filePath,
    content,
    status: "generated",
    version,
    artifactIds: [],
    updatedAt
  };
}

async function createTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forgeos-launcher-"));
  tempDirs.push(dir);
  return dir;
}
