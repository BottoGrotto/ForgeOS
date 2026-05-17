import { NextRequest, NextResponse } from "next/server";

export function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  if (!origin || !host) {
    return;
  }

  const originUrl = new URL(origin);
  if (originUrl.host !== host) {
    return NextResponse.json({ success: false, error: "Invalid request origin" }, { status: 403 });
  }

  return undefined;
}

export function apiJson<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, data }, init);
}

export function apiError(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}
