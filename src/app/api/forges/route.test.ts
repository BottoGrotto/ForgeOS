import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { DELETE, POST } from "./route";

function createRequest(name: string) {
  return new NextRequest("http://localhost/api/forges", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin: "http://localhost"
    },
    body: JSON.stringify({ name })
  });
}

describe("POST /api/forges", () => {
  it("creates a Forge from a name and generated slug", async () => {
    const response = await POST(createRequest(`API Forge ${Date.now()}`));
    const payload = (await response.json()) as { success: boolean; data?: { forge: { id: string; slug: string; name: string } } };

    expect(response.status).toBe(201);
    expect(payload.success).toBe(true);
    expect(payload.data?.forge.slug).toMatch(/^api-forge-\d+$/);
  });

  it("rejects duplicate slugs", async () => {
    const name = `Duplicate Forge ${Date.now()}`;
    await POST(createRequest(name));

    const response = await POST(createRequest(name));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(409);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("A Forge with this slug already exists.");
  });
});

describe("DELETE /api/forges", () => {
  it("deletes selected Forge slugs", async () => {
    const name = `Delete API Forge ${Date.now()}`;
    const created = await POST(createRequest(name));
    const createdPayload = (await created.json()) as { data?: { forge: { slug: string } } };
    const slug = createdPayload.data!.forge.slug;

    const response = await DELETE(
      new NextRequest("http://localhost/api/forges", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ slugs: [slug] })
      })
    );
    const payload = (await response.json()) as { success: boolean; data?: { deletedSlugs: string[]; forges: Array<{ slug: string }> } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.deletedSlugs).toEqual([slug]);
    expect(payload.data?.forges.some((forge) => forge.slug === slug)).toBe(false);
  });
});
