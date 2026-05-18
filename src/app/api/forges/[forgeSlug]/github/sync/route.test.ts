import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { encryptSecret } from "@/lib/security/tokens";
import { runtimeStore } from "@/lib/runtime/store";
import { POST } from "./route";

let forgeSlug = "";
const originalTokenSecret = process.env.FORGEOS_TOKEN_SECRET;

async function sync(body: Record<string, unknown>, slug = forgeSlug) {
  return POST(
    new NextRequest(`http://localhost/api/forges/${slug}/github/sync`, {
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

describe("POST /api/forges/[forgeSlug]/github/sync", () => {
  beforeEach(async () => {
    process.env.FORGEOS_TOKEN_SECRET = "test-secret";
    const response = await createForge(
      new NextRequest("http://localhost/api/forges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ name: `GitHub Sync API Forge ${Date.now()} ${Math.random()}` })
      })
    );
    const payload = (await response.json()) as { data?: { forge: { slug: string } } };
    forgeSlug = payload.data!.forge.slug;
    await runtimeStore.connectGitHubAccount(forgeSlug, {
      accountLogin: "octocat",
      accountId: "123",
      scopes: ["repo", "read:user"],
      tokenType: "bearer",
      encryptedAccessToken: encryptSecret("gho_secret")
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalTokenSecret) {
      process.env.FORGEOS_TOKEN_SECRET = originalTokenSecret;
    } else {
      delete process.env.FORGEOS_TOKEN_SECRET;
    }
  });

  it("syncs GitHub files into the requested Forge workspace", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ tree: [{ path: "README.md", type: "blob", size: 10 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("# Synced\n", { status: 200 }));

    const response = await sync({ owner: "BottoGrotto", repo: "ForgeOS", ref: "main" });
    const payload = (await response.json()) as { success: boolean; data?: { repository?: { syncStatus?: string }; files: Array<{ path: string; content: string }> } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.repository?.syncStatus).toBe("completed");
    expect(payload.data?.files.find((file) => file.path === "repo/README.md")?.content).toBe("# Synced\n");
    expect(JSON.stringify(payload)).not.toContain("gho_secret");
  });

  it("rejects sync requests without a connected GitHub account", async () => {
    const response = await sync({ owner: "BottoGrotto", repo: "ForgeOS", ref: "main" }, "missing-forge");
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(404);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Forge not found.");
  });
});
