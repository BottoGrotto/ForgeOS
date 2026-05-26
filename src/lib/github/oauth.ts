import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

interface GitHubOAuthStatePayload {
  forgeSlug: string;
  sessionHash: string;
  nonce: string;
  exp: number;
}

export function getGitHubOAuthConfig(request: NextRequest): GitHubOAuthConfig {
  const clientId = normalizeOAuthEnv(process.env.GITHUB_CLIENT_ID);
  const clientSecret = normalizeOAuthEnv(process.env.GITHUB_CLIENT_SECRET);
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

export function createGitHubOAuthStart(config: GitHubOAuthConfig, metadata: { forgeSlug: string; session: string; now?: number }): GitHubOAuthStart {
  const state = createSignedOAuthState(metadata.forgeSlug, metadata.session, metadata.now);
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

export function verifyGitHubOAuthState(state: string | undefined, session: string | undefined, now = Date.now()) {
  if (!state || !session) {
    return undefined;
  }

  const [encodedPayload, signature] = state.split(".");
  if (!encodedPayload || !signature || !safeEqual(signature, sign(encodedPayload))) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<GitHubOAuthStatePayload>;
    if (
      typeof payload.forgeSlug !== "string" ||
      typeof payload.sessionHash !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(now / 1000) ||
      payload.sessionHash !== hashSession(session)
    ) {
      return undefined;
    }

    return { forgeSlug: payload.forgeSlug };
  } catch {
    return undefined;
  }
}

export function getGitHubOAuthStatus(request: NextRequest) {
  const clientId = normalizeOAuthEnv(process.env.GITHUB_CLIENT_ID);
  const clientSecret = normalizeOAuthEnv(process.env.GITHUB_CLIENT_SECRET);
  const configuredBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.FORGEOS_APP_URL;
  const origin = configuredBaseUrl ?? request.nextUrl.origin;

  return {
    configured: Boolean(clientId && clientSecret),
    callbackUrl: new URL("/api/github/oauth/callback", origin).toString(),
    applicationSettingsUrl: clientId ? `https://github.com/settings/connections/applications/${clientId}` : undefined,
    missing: [
      clientId ? undefined : "GITHUB_CLIENT_ID",
      clientSecret ? undefined : "GITHUB_CLIENT_SECRET"
    ].filter((value): value is string => Boolean(value))
  };
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

function createSignedOAuthState(forgeSlug: string, session: string, now = Date.now()) {
  const payload: GitHubOAuthStatePayload = {
    forgeSlug,
    sessionHash: hashSession(session),
    nonce: randomToken(),
    exp: Math.floor(now / 1000) + COOKIE_MAX_AGE
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function hashSession(session: string) {
  return createHash("sha256").update(session).digest("base64url");
}

function sign(value: string) {
  const secret = process.env.FORGEOS_SESSION_SECRET;
  if (!secret) {
    throw new Error("FORGEOS_SESSION_SECRET is required.");
  }
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeOAuthEnv(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "..." || trimmed.includes("your-") || trimmed.includes("<")) {
    return undefined;
  }

  return trimmed;
}
