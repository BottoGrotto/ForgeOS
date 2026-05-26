import { NextRequest } from "next/server";
import { getGitHubOAuthStatus } from "@/lib/github/oauth";
import { apiJson } from "@/lib/security/request";

export async function GET(request: NextRequest) {
  return apiJson(getGitHubOAuthStatus(request));
}
