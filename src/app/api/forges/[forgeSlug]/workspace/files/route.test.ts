import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { GET, POST } from "./route";

let forgeSlug = "";

describe("/api/forges/[forgeSlug]/workspace/files", () => {
  beforeEach(async () => {
    forgeSlug = await createTestForge();
  });

  it("creates a workspace file and returns it in the requested Forge file list", async () => {
    const created = await saveWorkspaceFile({
      path: "./docs//plan.md",
      content: "# Plan"
    });
    const createdPayload = (await created.json()) as {
      success: boolean;
      data?: { id: string; path: string; content: string; status: string; version: number };
    };

    const listed = await GET(new NextRequest(`http://localhost/api/forges/${forgeSlug}/workspace/files`), {
      params: Promise.resolve({ forgeSlug })
    });
    const listedPayload = (await listed.json()) as {
      success: boolean;
      data?: Array<{ id: string; path: string; content: string; version: number }>;
    };

    expect(created.status).toBe(200);
    expect(createdPayload.success).toBe(true);
    expect(createdPayload.data).toMatchObject({
      path: "docs/plan.md",
      content: "# Plan",
      status: "generated",
      version: 1
    });
    expect(listed.status).toBe(200);
    expect(listedPayload.success).toBe(true);
    expect(listedPayload.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: createdPayload.data?.id, path: "docs/plan.md" })]));
  });

  it("updates an existing workspace file by normalized path", async () => {
    const created = await saveWorkspaceFile({
      path: "./src//app.ts",
      content: "export const value = 1;"
    });
    const createdPayload = (await created.json()) as { data?: { id: string; path: string; version: number } };

    const updated = await saveWorkspaceFile({
      path: "src/app.ts",
      content: "export const value = 2;"
    });
    const updatedPayload = (await updated.json()) as {
      success: boolean;
      data?: { id: string; path: string; content: string; version: number };
    };

    expect(updated.status).toBe(200);
    expect(updatedPayload.success).toBe(true);
    expect(updatedPayload.data).toMatchObject({
      id: createdPayload.data?.id,
      path: "src/app.ts",
      content: "export const value = 2;",
      version: 2
    });
  });

  it("returns validation details for missing path or content fields", async () => {
    const response = await saveWorkspaceFile({ path: "" });
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Invalid workspace file");
    expect(payload.error).toContain("path");
    expect(payload.error).toContain("content");
  });

  it("returns a path error for workspace paths that escape the virtual workspace", async () => {
    const response = await saveWorkspaceFile({
      path: "../secrets.env",
      content: "SECRET=1"
    });
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(500);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Workspace file save failed");
  });

  it("rejects cross-origin workspace file writes", async () => {
    const response = await saveWorkspaceFile(
      {
        path: "docs/csrf.md",
        content: "blocked"
      },
      forgeSlug,
      "http://evil.example"
    );
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(403);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Invalid request origin");
  });

  it("returns not found errors for unknown Forge slugs", async () => {
    const listed = await GET(new NextRequest("http://localhost/api/forges/missing-forge/workspace/files"), {
      params: Promise.resolve({ forgeSlug: "missing-forge" })
    });
    const listedPayload = (await listed.json()) as { success: boolean; error?: string };
    const saved = await saveWorkspaceFile({ path: "docs/missing.md", content: "missing" }, "missing-forge");
    const savedPayload = (await saved.json()) as { success: boolean; error?: string };

    expect(listed.status).toBe(404);
    expect(listedPayload).toEqual({ success: false, error: "Forge not found." });
    expect(saved.status).toBe(404);
    expect(savedPayload).toEqual({ success: false, error: "Forge not found." });
  });
});

async function createTestForge() {
  const response = await createForge(
    new NextRequest("http://localhost/api/forges", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost"
      },
      body: JSON.stringify({ name: `Workspace Files API Forge ${Date.now()} ${Math.random()}`, template: "empty" })
    })
  );
  const payload = (await response.json()) as { data?: { forge: { slug: string } } };
  return payload.data!.forge.slug;
}

function saveWorkspaceFile(body: Record<string, unknown>, slug = forgeSlug, origin = "http://localhost") {
  return POST(
    new NextRequest(`http://localhost/api/forges/${slug}/workspace/files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin
      },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ forgeSlug: slug }) }
  );
}
