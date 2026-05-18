import { NextRequest, NextResponse } from "next/server";
import { exchangeGitHubOAuthCode, fetchGitHubAuthenticatedUser } from "@/lib/github/client";
import { clearGitHubOAuthCookies, getGitHubOAuthConfig, readGitHubOAuthCookies } from "@/lib/github/oauth";
import { encryptSecret } from "@/lib/security/tokens";
import { runtimeStore } from "@/lib/runtime/store";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const cookies = readGitHubOAuthCookies(request);
  const redirectTarget = new URL(cookies.forgeSlug ? `/forge/${cookies.forgeSlug}/workspace` : "/forges", request.nextUrl.origin);

  if (!code || !state || !cookies.state || !cookies.verifier || !cookies.forgeSlug || state !== cookies.state) {
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
    await runtimeStore.connectGitHubAccount(cookies.forgeSlug, {
      accountLogin: user.login,
      accountId: user.id,
      scopes: token.scopes,
      tokenType: token.tokenType,
      encryptedAccessToken: encryptSecret(token.accessToken)
    });
    redirectTarget.searchParams.set("github", "connected");
  } catch {
    redirectTarget.searchParams.set("github", "oauth_failed");
  }

  const response = NextResponse.redirect(redirectTarget);
  clearGitHubOAuthCookies(response);
  return response;
}
