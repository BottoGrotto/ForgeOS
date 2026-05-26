import { NextRequest, NextResponse } from "next/server";
import { getGitHubOAuthConfig, createGitHubOAuthStart, setGitHubOAuthCookies } from "@/lib/github/oauth";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, getAuthenticatedOperatorSession } from "@/lib/security/request";

export async function GET(request: NextRequest) {
  const canonicalUrl = canonicalOAuthStartUrl(request);
  if (canonicalUrl) {
    return NextResponse.redirect(canonicalUrl);
  }

  const forgeSlug = request.nextUrl.searchParams.get("forgeSlug")?.trim();
  if (!forgeSlug) {
    return apiError("Forge slug is required.", 400);
  }

  const session = getAuthenticatedOperatorSession(request);
  if (!session) {
    return apiError("Authentication required", 401);
  }

  try {
    await runtimeStore.getSnapshot(forgeSlug);
    const config = getGitHubOAuthConfig(request);
    const start = createGitHubOAuthStart(config, { forgeSlug, session });
    const response = NextResponse.redirect(start.authorizationUrl);
    setGitHubOAuthCookies(response, start, forgeSlug);
    return response;
  } catch (error) {
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("GitHub OAuth is not configured.", 500);
  }
}

function canonicalOAuthStartUrl(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (!host.startsWith("0.0.0.0")) {
    return undefined;
  }

  const url = new URL(request.url);
  url.hostname = "localhost";
  return url;
}
