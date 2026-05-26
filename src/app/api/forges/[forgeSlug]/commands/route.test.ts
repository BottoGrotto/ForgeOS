import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { POST } from "./route";

let forgeSlug = "";

async function command(body: Record<string, unknown>, slug = forgeSlug) {
  return POST(
    new NextRequest(`http://localhost/api/forges/${slug}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost"
      },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ forgeSlug: slug }) }
  );
}

describe("POST /api/forges/[forgeSlug]/commands", () => {
  beforeEach(async () => {
    const response = await createForge(
      new NextRequest("http://localhost/api/forges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ name: `Command API Forge ${Date.now()} ${Math.random()}`, template: "demo" })
      })
    );
    const payload = (await response.json()) as { data?: { forge: { slug: string } } };
    forgeSlug = payload.data!.forge.slug;
  });

  it("returns a completed snapshot for the full Forge flow", async () => {
    const response = await command({ type: "run_full_flow", idempotencyKey: "api-full-flow" });
    const payload = (await response.json()) as { success: boolean; data?: { forge: { activePhase: string; slug: string } } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.forge.slug).toBe(forgeSlug);
    expect(payload.data?.forge.activePhase).toBe("Deployment Ready");
  });

  it("runs a selected ready operation on the requested Forge", async () => {
    const response = await command({ type: "run_operation", operationId: `${forgeSlug}-op-runtime`, idempotencyKey: "api-run-runtime" });
    const payload = (await response.json()) as { success: boolean; data?: { operations: Array<{ id: string; status: string }> } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.operations.find((operation) => operation.id === `${forgeSlug}-op-runtime`)?.status).toBe("running");
    expect(payload.data?.operations.find((operation) => operation.id === `${forgeSlug}-op-tests`)?.status).toBe("blocked");
  });

  it("accepts scheduler ticks and queues eligible operations", async () => {
    const response = await command({ type: "scheduler_tick", idempotencyKey: "api-scheduler-tick" });
    const payload = (await response.json()) as {
      success: boolean;
      data?: { forge: { slug: string }; operations: Array<{ id: string; status: string }>; events: Array<{ type: string; payload: Record<string, unknown> }> };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.forge.slug).toBe(forgeSlug);
    expect(payload.data?.operations.find((operation) => operation.id === `${forgeSlug}-op-runtime`)?.status).toBe("running");
    expect(payload.data?.events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.queued"]));
    expect(payload.data?.events.find((event) => event.type === "run.queued")?.payload.operationId).toBe(`${forgeSlug}-op-runtime`);
  });

  it("accepts Executive proposal commands through the command API", async () => {
    const response = await command({
      type: "propose_operation_changes",
      message: "Route QA behind runtime contracts.",
      idempotencyKey: "api-proposal-create"
    });
    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        operations: Array<{ id: string; priority: string }>;
        proposals: Array<{ id: string; status: string }>;
        events: Array<{ type: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.operations.find((operation) => operation.id === `${forgeSlug}-op-runtime`)?.priority).toBe("high");
    expect(payload.data?.proposals).toHaveLength(0);
    expect(payload.data?.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_failed"]));
  });

  it("returns validation details when an inline Executive prompt is too large", async () => {
    const response = await command({
      type: "propose_operation_changes",
      message: "x".repeat(2001),
      idempotencyKey: "api-proposal-too-large"
    });
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("message");
    expect(payload.error).toContain("at most 2000");
  });

  it("accepts Executive commands that reference a workspace prompt file", async () => {
    const saved = await fetchWorkspaceFile(forgeSlug, {
      path: "instructions.md",
      content: "# Large Instructions\n\nBuild a full project from this brief."
    });

    const response = await command({
      type: "propose_operation_changes",
      message: "Use the workspace brief.",
      promptFilePath: saved.path,
      idempotencyKey: "api-proposal-file"
    });
    const payload = (await response.json()) as { success: boolean; data?: { events: Array<{ type: string }> } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_failed"]));
  });

  it("runs project launcher checks through the command API", async () => {
    await fetchWorkspaceFile(forgeSlug, {
      path: "package.json",
      content: JSON.stringify({
        scripts: {
          test: `${process.execPath} -e "console.log('launcher api ok')"`
        }
      })
    });

    const response = await command({
      type: "run_project_check",
      launcherTier: "development",
      launcherScript: "auto",
      launcherId: "api-check"
    });
    const payload = (await response.json()) as { success: boolean; data?: { events: Array<{ type: string; payload: Record<string, unknown> }> } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.events.map((event) => event.type)).toEqual(expect.arrayContaining(["launcher.materialized", "launcher.check_completed", "launcher.log"]));
    expect(payload.data?.events.find((event) => event.type === "launcher.check_completed")?.payload).toMatchObject({
      launcherId: "api-check",
      status: "passed",
      commandIds: ["test"]
    });
  });

  it("starts and stops project previews through the command API", async () => {
    await fetchWorkspaceFile(forgeSlug, {
      path: "package.json",
      content: JSON.stringify({
        scripts: {
          dev: `${process.execPath} -e "const http=require('node:http'); const port=Number(process.env.PORT); http.createServer((_,res)=>res.end('api ready')).listen(port, '127.0.0.1')"`
        }
      })
    });

    const started = await command({
      type: "start_project_preview",
      previewScript: "dev",
      launcherId: "api-preview"
    });
    const startedPayload = (await started.json()) as { success: boolean; data?: { events: Array<{ type: string; payload: Record<string, unknown> }> } };
    const ready = startedPayload.data?.events.find((event) => event.type === "launcher.preview_ready");
    const url = typeof ready?.payload.url === "string" ? ready.payload.url : "";

    expect(started.status).toBe(200);
    expect(startedPayload.success).toBe(true);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const stopped = await command({ type: "stop_project_preview", launcherId: "api-preview" });
    const stoppedPayload = (await stopped.json()) as { success: boolean; data?: { events: Array<{ type: string; payload: Record<string, unknown> }> } };

    expect(stopped.status).toBe(200);
    expect(stoppedPayload.data?.events.at(-1)).toMatchObject({
      type: "launcher.preview_stopped",
      payload: { launcherId: "api-preview", stopReason: "operator_requested" }
    });
  });

  it("pauses, resumes, and resets only the requested Forge", async () => {
    const otherResponse = await createForge(
      new NextRequest("http://localhost/api/forges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ name: `Other Runtime API Forge ${Date.now()} ${Math.random()}`, template: "demo" })
      })
    );
    const otherPayload = (await otherResponse.json()) as { data?: { forge: { slug: string } } };
    const otherSlug = otherPayload.data!.forge.slug;

    const paused = await command({ type: "pause_forge", idempotencyKey: "api-pause-forge" });
    const pausedPayload = (await paused.json()) as { data?: { forge: { status: string; activePhase: string } } };
    const resumed = await command({ type: "resume_forge", idempotencyKey: "api-resume-forge" });
    const resumedPayload = (await resumed.json()) as { data?: { forge: { status: string } } };
    await command({ type: "run_operation", operationId: `${forgeSlug}-op-runtime`, idempotencyKey: "api-run-before-reset" });
    const reset = await command({ type: "reset_demo_state", idempotencyKey: "api-reset-forge" });
    const resetPayload = (await reset.json()) as { data?: { operations: Array<{ id: string; status: string }>; forge: { slug: string } } };
    const other = await command({ type: "operator_message", message: "Status?", idempotencyKey: "api-other-message" }, otherSlug);
    const otherSnapshot = (await other.json()) as { data?: { operations: Array<{ id: string; status: string }>; forge: { slug: string } } };

    expect(paused.status).toBe(200);
    expect(pausedPayload.data?.forge).toMatchObject({ status: "paused", activePhase: "Safe Shutdown" });
    expect(resumedPayload.data?.forge.status).toBe("active");
    expect(resetPayload.data?.forge.slug).toBe(forgeSlug);
    expect(resetPayload.data?.operations.find((operation) => operation.id === `${forgeSlug}-op-runtime`)?.status).toBe("ready");
    expect(otherSnapshot.data?.forge.slug).toBe(otherSlug);
    expect(otherSnapshot.data?.operations.find((operation) => operation.id === `${otherSlug}-op-runtime`)?.status).toBe("ready");
  });

  it("scopes repeated idempotency keys to each Forge", async () => {
    const otherResponse = await createForge(
      new NextRequest("http://localhost/api/forges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ name: `Idempotent Command API Forge ${Date.now()} ${Math.random()}`, template: "demo" })
      })
    );
    const otherPayload = (await otherResponse.json()) as { data?: { forge: { slug: string } } };
    const otherSlug = otherPayload.data!.forge.slug;

    await command({ type: "run_operation", operationId: `${forgeSlug}-op-runtime`, idempotencyKey: "same-api-key" });
    const other = await command({ type: "run_operation", operationId: `${otherSlug}-op-runtime`, idempotencyKey: "same-api-key" }, otherSlug);
    const otherSnapshot = (await other.json()) as { data?: { operations: Array<{ id: string; status: string }> } };

    expect(other.status).toBe(200);
    expect(otherSnapshot.data?.operations.find((operation) => operation.id === `${otherSlug}-op-runtime`)?.status).toBe("running");
  });

  it("returns not found for unknown Forge slugs", async () => {
    const response = await command({ type: "pause_forge", idempotencyKey: "missing-forge" }, "missing-forge");
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(404);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Forge not found.");
  });

  it("keeps repository commands scoped to the requested Forge", async () => {
    const otherResponse = await createForge(
      new NextRequest("http://localhost/api/forges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ name: `Other Command API Forge ${Date.now()} ${Math.random()}`, template: "demo" })
      })
    );
    const otherPayload = (await otherResponse.json()) as { data?: { forge: { slug: string } } };
    const otherSlug = otherPayload.data!.forge.slug;

    const connected = await command({
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1",
      idempotencyKey: "api-connect-repository"
    });
    const connectedPayload = (await connected.json()) as { data?: { repository?: { owner: string } } };
    const other = await command({ type: "operator_message", message: "Status?", idempotencyKey: "other-message" }, otherSlug);
    const otherSnapshot = (await other.json()) as { data?: { repository?: { owner: string } } };

    expect(connectedPayload.data?.repository?.owner).toBe("BottoGrotto");
    expect(otherSnapshot.data?.repository).toBeUndefined();
  });
});

async function fetchWorkspaceFile(slug: string, body: Record<string, unknown>) {
  const { POST: saveFile } = await import("@/app/api/forges/[forgeSlug]/workspace/files/route");
  const response = await saveFile(
    new NextRequest(`http://localhost/api/forges/${slug}/workspace/files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost"
      },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ forgeSlug: slug }) }
  );
  const payload = (await response.json()) as { data?: { id: string; path: string } };
  return payload.data!;
}
