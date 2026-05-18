import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "forgeos_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  sub: "operator";
  exp: number;
}

export function createOperatorSession(now = Date.now()) {
  const payload: SessionPayload = {
    sub: "operator",
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyOperatorSession(value: string | undefined, now = Date.now()) {
  if (!value) {
    return false;
  }

  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) {
    return false;
  }

  const expected = sign(encodedPayload);
  if (!safeEqual(signature, expected)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<SessionPayload>;
    return payload.sub === "operator" && typeof payload.exp === "number" && payload.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  };
}

export function getOperatorPassword() {
  const password = process.env.FORGEOS_OPERATOR_PASSWORD;
  if (!password) {
    throw new Error("FORGEOS_OPERATOR_PASSWORD is required.");
  }
  return password;
}

function sign(value: string) {
  return createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

function getSessionSecret() {
  const secret = process.env.FORGEOS_SESSION_SECRET ?? process.env.FORGEOS_TOKEN_SECRET;
  if (!secret) {
    throw new Error("FORGEOS_SESSION_SECRET or FORGEOS_TOKEN_SECRET is required.");
  }
  return secret;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
