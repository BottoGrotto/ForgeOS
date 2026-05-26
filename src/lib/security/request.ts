import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifyOperatorSession } from "@/lib/auth/session";

export function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const source = origin ?? referer;

  if (!source) {
    return apiError("Invalid request origin", 403);
  }

  try {
    const sourceUrl = new URL(source);
    const requestUrl = new URL(request.url);
    const requestHost = request.headers.get("host") ?? requestUrl.host;
    if (sourceUrl.protocol !== requestUrl.protocol || sourceUrl.host !== requestHost) {
      return apiError("Invalid request origin", 403);
    }
  } catch {
    return apiError("Invalid request origin", 403);
  }

  return undefined;
}

export function getAuthenticatedOperatorSession(request: NextRequest) {
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  return verifyOperatorSession(session) ? session : undefined;
}

export function apiJson<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, data }, withApiHeaders(init));
}

export function apiError(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, withApiHeaders({ status }));
}

function withApiHeaders(init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("pragma", "no-cache");
  setVaryCookie(headers);
  return { ...init, headers };
}

function setVaryCookie(headers: Headers) {
  const vary = headers.get("vary");
  if (!vary) {
    headers.set("vary", "Cookie");
    return;
  }

  const values = vary.split(",").map((value) => value.trim().toLowerCase());
  if (!values.includes("cookie")) {
    headers.set("vary", `${vary}, Cookie`);
  }
}
