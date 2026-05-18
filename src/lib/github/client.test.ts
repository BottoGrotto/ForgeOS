import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeGitHubOAuthCode, fetchGitHubAuthenticatedUser, listGitHubRepositories, syncGitHubRepositoryFiles } from "./client";

describe("GitHub client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exchanges OAuth codes and fetches authenticated identity", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_test", token_type: "bearer", scope: "repo,read:user" }))
      .mockResolvedValueOnce(jsonResponse({ id: 123, login: "octocat" }));

    const token = await exchangeGitHubOAuthCode({
      clientId: "client",
      clientSecret: "secret",
      code: "code",
      redirectUri: "http://127.0.0.1/callback",
      codeVerifier: "verifier"
    });
    const user = await fetchGitHubAuthenticatedUser(token.accessToken);

    expect(token).toMatchObject({ accessToken: "gho_test", scopes: ["repo", "read:user"] });
    expect(user).toEqual({ id: "123", login: "octocat" });
  });

  it("lists repositories and syncs bounded text files", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ id: 1, name: "ForgeOS", full_name: "BottoGrotto/ForgeOS", private: true, default_branch: "main", owner: { login: "BottoGrotto" } }]))
      .mockResolvedValueOnce(jsonResponse({ tree: [{ path: "README.md", type: "blob", size: 12 }, { path: ".git/config", type: "blob", size: 12 }, { path: "image.png", type: "blob", size: 12 }] }))
      .mockResolvedValueOnce(textResponse("# ForgeOS\n"));

    const repos = await listGitHubRepositories("token");
    const files = await syncGitHubRepositoryFiles("token", { owner: "BottoGrotto", repo: "ForgeOS", ref: "main" });

    expect(repos).toEqual([{ id: 1, owner: "BottoGrotto", name: "ForgeOS", fullName: "BottoGrotto/ForgeOS", private: true, defaultBranch: "main", updatedAt: undefined }]);
    expect(files).toEqual([{ path: "README.md", content: "# ForgeOS\n" }]);
  });
});

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function textResponse(payload: string) {
  return new Response(payload, { status: 200, headers: { "content-type": "text/plain" } });
}
