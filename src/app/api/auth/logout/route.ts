import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { apiJson, assertSameOrigin } from "@/lib/security/request";

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  const response = apiJson({ authenticated: false });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
