import { NextRequest } from "next/server";
import { clearFailedLogins, getLoginRateLimitKey, getLoginRateLimitRetrySeconds, isLoginRateLimited, recordFailedLogin } from "@/lib/auth/login-rate-limit";
import { createOperatorSession, getOperatorPassword, getSessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  let body: { password?: unknown };
  try {
    body = (await request.json()) as { password?: unknown };
  } catch {
    return apiError("Invalid login request", 400);
  }

  const clientKey = getLoginRateLimitKey(request);
  if (isLoginRateLimited(clientKey)) {
    const response = apiError("Too many login attempts. Try again shortly.", 429);
    response.headers.set("retry-after", String(getLoginRateLimitRetrySeconds()));
    return response;
  }

  try {
    if (typeof body.password !== "string" || body.password !== getOperatorPassword()) {
      recordFailedLogin(clientKey);
      return apiError("Invalid operator password", 401);
    }

    clearFailedLogins(clientKey);
    const response = apiJson({ authenticated: true });
    response.cookies.set(SESSION_COOKIE, createOperatorSession(), getSessionCookieOptions());
    return response;
  } catch {
    return apiError("Operator login is not configured", 500);
  }
}
