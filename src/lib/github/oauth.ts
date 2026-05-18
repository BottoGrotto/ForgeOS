import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const STATE_COOKIE = "forgeos_github_oauth_state";
const VERIFIER_COOKIE = "forgeos_github_oauth_verifier";
const FORGE_COOKIE = "forgeos_github_oauth_forge";
const COOKIE_MAX_AGE = 10 * 60;

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GitHubOAuthStart {
  state: string;
  verifier: string;
  authorizationUrl: string;
}

export function getGitHubOAuthConfig(request: NextRequest): GitHubOAuthConfig {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GitHub OAuth is not configured.");
  }

  const configuredBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.FORGEOS_APP_URL;
  const origin = configuredBaseUrl ?? request.nextUrl.origin;
  return {
    clientId,
    clientSecret,
    redirectUri: new URL("/api/github/oauth/callback", origin).toString()
  };
}

export function createGitHubOAuthStart(config: GitHubOAuthConfig): GitHubOAuthStart {
  const state = randomToken();
  const verifier = randomToken();
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("scope", "repo read:user");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  return { state, verifier, authorizationUrl: authorizationUrl.toString() };
}

export function setGitHubOAuthCookies(response: NextResponse, start: GitHubOAuthStart, forgeSlug: string) {
  const options = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", maxAge: COOKIE_MAX_AGE, path: "/" };
  response.cookies.set(STATE_COOKIE, start.state, options);
  response.cookies.set(VERIFIER_COOKIE, start.verifier, options);
  response.cookies.set(FORGE_COOKIE, forgeSlug, options);
}

export function readGitHubOAuthCookies(request: NextRequest) {
  return {
    state: request.cookies.get(STATE_COOKIE)?.value,
    verifier: request.cookies.get(VERIFIER_COOKIE)?.value,
    forgeSlug: request.cookies.get(FORGE_COOKIE)?.value
  };
}

export function clearGitHubOAuthCookies(response: NextResponse) {
  response.cookies.delete(STATE_COOKIE);
  response.cookies.delete(VERIFIER_COOKIE);
  response.cookies.delete(FORGE_COOKIE);
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}
