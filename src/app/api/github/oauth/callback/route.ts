import { NextRequest, NextResponse } from "next/server";
import { exchangeGitHubOAuthCode, fetchGitHubAuthenticatedUser } from "@/lib/github/client";
import { clearGitHubOAuthCookies, getGitHubOAuthConfig, readGitHubOAuthCookies, verifyGitHubOAuthState } from "@/lib/github/oauth";
import { encryptSecret } from "@/lib/security/tokens";
import { runtimeStore } from "@/lib/runtime/store";
import { getAuthenticatedOperatorSession } from "@/lib/security/request";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const cookies = readGitHubOAuthCookies(request);
  const session = getAuthenticatedOperatorSession(request);
  const verifiedState = state === cookies.state ? verifyGitHubOAuthState(state, session) : undefined;
  const verifiedForgeSlug = verifiedState?.forgeSlug;
  const safeForgeSlug = isSafeForgeSlug(verifiedForgeSlug) ? verifiedForgeSlug : isSafeForgeSlug(cookies.forgeSlug) ? cookies.forgeSlug : undefined;
  const redirectTarget = new URL(safeForgeSlug ? `/forge/${safeForgeSlug}/workspace` : "/forges", request.nextUrl.origin);

  if (!code || !state || !cookies.state || !cookies.verifier || !safeForgeSlug || !verifiedState) {
    redirectTarget.searchParams.set("github", "oauth_failed");
    const response = NextResponse.redirect(redirectTarget);
    clearGitHubOAuthCookies(response);
    return response;
  }

  try {
    const config = getGitHubOAuthConfig(request);
    const token = await exchangeGitHubOAuthCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: config.redirectUri,
      codeVerifier: cookies.verifier
    });
    const user = await fetchGitHubAuthenticatedUser(token.accessToken);
    await runtimeStore.connectGitHubAccount(safeForgeSlug, {
      accountLogin: user.login,
      accountId: user.id,
      scopes: token.scopes,
      tokenType: token.tokenType,
      encryptedAccessToken: encryptSecret(token.accessToken)
    });
    redirectTarget.searchParams.set("github", "connected");
  } catch (error) {
    console.error("GitHub OAuth callback failed", {
      reason: error instanceof Error ? error.message : "Unknown error"
    });
    redirectTarget.searchParams.set("github", "oauth_failed");
  }

  const response = NextResponse.redirect(redirectTarget);
  clearGitHubOAuthCookies(response);
  return response;
}

function isSafeForgeSlug(value: string | undefined) {
  return Boolean(value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value));
}
