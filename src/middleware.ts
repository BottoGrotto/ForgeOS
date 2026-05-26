import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "forgeos_session";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const authenticated = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (authenticated) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    const response = NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("pragma", "no-cache");
    response.headers.set("vary", "Cookie");
    return response;
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"]
};

function isPublicPath(pathname: string) {
  return pathname === "/login" || pathname === "/api/auth/login" || pathname === "/api/github/oauth/callback" || pathname === "/api/github/oauth/config";
}

async function verifySession(value: string | undefined) {
  if (!value) {
    return false;
  }

  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) {
    return false;
  }

  const expected = await sign(encodedPayload);
  if (signature !== expected) {
    return false;
  }

  try {
    const payload = JSON.parse(atobUrl(encodedPayload)) as { sub?: unknown; exp?: unknown };
    return payload.sub === "operator" && typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function sign(value: string) {
  const secret = process.env.FORGEOS_SESSION_SECRET;
  if (!secret) {
    return "";
  }

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoaUrl(new Uint8Array(signature));
}

function atobUrl(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(normalized);
}

function btoaUrl(value: Uint8Array) {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
