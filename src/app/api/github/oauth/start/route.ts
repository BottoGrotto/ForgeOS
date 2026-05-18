import { NextRequest, NextResponse } from "next/server";
import { getGitHubOAuthConfig, createGitHubOAuthStart, setGitHubOAuthCookies } from "@/lib/github/oauth";

export async function GET(request: NextRequest) {
  const forgeSlug = request.nextUrl.searchParams.get("forgeSlug")?.trim();
  if (!forgeSlug) {
    return NextResponse.json({ success: false, error: "Forge slug is required." }, { status: 400 });
  }

  try {
    const config = getGitHubOAuthConfig(request);
    const start = createGitHubOAuthStart(config);
    const response = NextResponse.redirect(start.authorizationUrl);
    setGitHubOAuthCookies(response, start, forgeSlug);
    return response;
  } catch {
    return NextResponse.json({ success: false, error: "GitHub OAuth is not configured." }, { status: 500 });
  }
}
