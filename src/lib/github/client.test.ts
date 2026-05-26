import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeGitHubOAuthCode, fetchGitHubAuthenticatedUser, listGitHubRepositories, syncGitHubRepositoryFiles } from "./client";

describe("GitHub client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exchanges OAuth codes and fetches authenticated identity", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
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
    expect(fetchMock).toHaveBeenCalledWith("https://github.com/login/oauth/access_token", expect.objectContaining({
      headers: expect.objectContaining({ "content-type": "application/x-www-form-urlencoded" }),
      body: expect.any(URLSearchParams)
    }));
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body?.toString()).toContain("client_id=client");
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

  it("paginates repository listings so private repositories are not hidden after the first page", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ id: 1, name: "public-repo", full_name: "BottoGrotto/public-repo", private: false, default_branch: "main", owner: { login: "BottoGrotto" } }], '<https://api.github.com/user/repos?page=2>; rel="next"'))
      .mockResolvedValueOnce(jsonResponse([{ id: 2, name: "private-repo", full_name: "BottoGrotto/private-repo", private: true, default_branch: "main", owner: { login: "BottoGrotto" } }]));

    const repos = await listGitHubRepositories("token");

    expect(repos.map((repo) => `${repo.fullName}:${repo.private ? "private" : "public"}`)).toEqual([
      "BottoGrotto/public-repo:public",
      "BottoGrotto/private-repo:private"
    ]);
  });
});

function jsonResponse(payload: unknown, link?: string) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...(link ? { link } : {}) } });
}

function textResponse(payload: string) {
  return new Response(payload, { status: 200, headers: { "content-type": "text/plain" } });
}
