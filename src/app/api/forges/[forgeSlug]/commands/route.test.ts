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
        body: JSON.stringify({ name: `Command API Forge ${Date.now()} ${Math.random()}` })
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
    expect(payload.data?.operations.find((operation) => operation.id === `${forgeSlug}-op-runtime`)?.status).toBe("completed");
    expect(payload.data?.operations.find((operation) => operation.id === `${forgeSlug}-op-tests`)?.status).toBe("ready");
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
        body: JSON.stringify({ name: `Other Runtime API Forge ${Date.now()} ${Math.random()}` })
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
        body: JSON.stringify({ name: `Idempotent Command API Forge ${Date.now()} ${Math.random()}` })
      })
    );
    const otherPayload = (await otherResponse.json()) as { data?: { forge: { slug: string } } };
    const otherSlug = otherPayload.data!.forge.slug;

    await command({ type: "run_operation", operationId: `${forgeSlug}-op-runtime`, idempotencyKey: "same-api-key" });
    const other = await command({ type: "run_operation", operationId: `${otherSlug}-op-runtime`, idempotencyKey: "same-api-key" }, otherSlug);
    const otherSnapshot = (await other.json()) as { data?: { operations: Array<{ id: string; status: string }> } };

    expect(other.status).toBe(200);
    expect(otherSnapshot.data?.operations.find((operation) => operation.id === `${otherSlug}-op-runtime`)?.status).toBe("completed");
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
        body: JSON.stringify({ name: `Other Command API Forge ${Date.now()} ${Math.random()}` })
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
