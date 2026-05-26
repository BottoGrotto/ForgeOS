import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { POST as saveFile } from "@/app/api/forges/[forgeSlug]/workspace/files/route";
import { GET } from "./route";

let forgeSlug = "";

describe("GET /api/forges/[forgeSlug]/workspace/files/[id]", () => {
  beforeEach(async () => {
    forgeSlug = await createTestForge();
  });

  it("returns a workspace file by id from the requested Forge", async () => {
    const file = await createWorkspaceFile({
      path: "src/index.ts",
      content: "export const answer = 42;"
    });

    const response = await GET(new NextRequest(`http://localhost/api/forges/${forgeSlug}/workspace/files/${file.id}`), {
      params: Promise.resolve({ forgeSlug, id: file.id })
    });
    const payload = (await response.json()) as {
      success: boolean;
      data?: { id: string; path: string; content: string; version: number };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data).toMatchObject({
      id: file.id,
      path: "src/index.ts",
      content: "export const answer = 42;",
      version: 1
    });
  });

  it("returns not found when the id is not in the requested Forge", async () => {
    const otherForgeSlug = await createTestForge();
    const otherFile = await createWorkspaceFile({ path: "docs/other.md", content: "other" }, otherForgeSlug);

    const response = await GET(new NextRequest(`http://localhost/api/forges/${forgeSlug}/workspace/files/${otherFile.id}`), {
      params: Promise.resolve({ forgeSlug, id: otherFile.id })
    });
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(404);
    expect(payload).toEqual({ success: false, error: "Virtual file not found" });
  });

  it("returns not found for unknown Forge slugs before resolving an id", async () => {
    const response = await GET(new NextRequest("http://localhost/api/forges/missing-forge/workspace/files/missing-id"), {
      params: Promise.resolve({ forgeSlug: "missing-forge", id: "missing-id" })
    });
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(404);
    expect(payload).toEqual({ success: false, error: "Forge not found." });
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
      body: JSON.stringify({ name: `Workspace File ID API Forge ${Date.now()} ${Math.random()}`, template: "empty" })
    })
  );
  const payload = (await response.json()) as { data?: { forge: { slug: string } } };
  return payload.data!.forge.slug;
}

async function createWorkspaceFile(body: Record<string, unknown>, slug = forgeSlug) {
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
  const payload = (await response.json()) as { data?: { id: string; path: string; content: string } };
  return payload.data!;
}
