import { NextRequest } from "next/server";
import { createOperatorSession, getOperatorPassword, getSessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password !== "string" || body.password !== getOperatorPassword()) {
      return apiError("Invalid operator password", 401);
    }

    const response = apiJson({ authenticated: true });
    response.cookies.set(SESSION_COOKIE, createOperatorSession(), getSessionCookieOptions());
    return response;
  } catch {
    return apiError("Operator login is not configured", 500);
  }
}
