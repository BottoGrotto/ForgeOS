import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POST /api/runtime/commands", () => {
  beforeEach(async () => {
    await POST(
      new NextRequest("http://localhost/api/runtime/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({
          type: "reset_demo_state",
          idempotencyKey: `api-reset-${Date.now()}-${Math.random()}`
        })
      })
    );
  });

  it("returns a completed snapshot for the full demo flow", async () => {
    const request = new NextRequest("http://localhost/api/runtime/commands", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost"
      },
      body: JSON.stringify({
        type: "run_full_flow",
        idempotencyKey: "api-full-flow"
      })
    });

    const response = await POST(request);
    const payload = (await response.json()) as { success: boolean; data?: { forge: { activePhase: string } } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.forge.activePhase).toBe("Deployment Ready");
  });

  it("returns a conflict response for strict runtime command rejection", async () => {
    const request = new NextRequest("http://localhost/api/runtime/commands", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost"
      },
      body: JSON.stringify({
        type: "run_operation",
        operationId: "op-tests",
        idempotencyKey: "api-blocked-operation"
      })
    });

    const response = await POST(request);
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(409);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Operation is blocked until its dependencies complete.");
  });
});
