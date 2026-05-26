import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { DELETE, GET } from "./route";

function deleteRequest(origin = "http://localhost") {
  return new NextRequest("http://localhost/api/dev/runtime-store", {
    method: "DELETE",
    headers: {
      host: "localhost",
      origin
    }
  });
}

describe("/api/dev/runtime-store", () => {
  it("exposes runtime storage metadata", async () => {
    const response = await GET();
    const payload = (await response.json()) as { success: boolean; data?: { storage: { mode: string; resettable: boolean; visible: boolean } } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.storage).toMatchObject({ mode: "memory", resettable: true, visible: true });
  });

  it("clears resettable development storage", async () => {
    const response = await DELETE(deleteRequest());
    const payload = (await response.json()) as { success: boolean; data?: { forges: unknown[]; storage: { resettable: boolean } } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.storage.resettable).toBe(true);
    expect(payload.data?.forges).toEqual([]);
  });

  it("rejects cross-origin clear requests", async () => {
    const response = await DELETE(deleteRequest("http://evil.example"));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(403);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Invalid request origin");
  });
});
