import { NextRequest } from "next/server";

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_RETRY_SECONDS = 60;

const failedLoginAttempts = new Map<string, { count: number; resetAt: number }>();

export function getLoginRateLimitRetrySeconds() {
  return LOGIN_RETRY_SECONDS;
}

export function isLoginRateLimited(clientKey: string) {
  const record = getActiveRecord(clientKey);
  return Boolean(record && record.count >= MAX_FAILED_LOGIN_ATTEMPTS);
}

export function recordFailedLogin(clientKey: string) {
  const record = getActiveRecord(clientKey);
  failedLoginAttempts.set(clientKey, {
    count: (record?.count ?? 0) + 1,
    resetAt: Date.now() + LOGIN_RETRY_SECONDS * 1000
  });
}

export function clearFailedLogins(clientKey: string) {
  failedLoginAttempts.delete(clientKey);
}

export function getLoginRateLimitKey(request: NextRequest) {
  if (trustsProxyHeaders()) {
    const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const realIp = request.headers.get("x-real-ip")?.trim();
    return forwardedFor || realIp || "local";
  }

  return "local";
}

export function resetLoginRateLimitForTests() {
  failedLoginAttempts.clear();
}

function getActiveRecord(clientKey: string) {
  const record = failedLoginAttempts.get(clientKey);
  if (!record) {
    return undefined;
  }

  if (record.resetAt <= Date.now()) {
    failedLoginAttempts.delete(clientKey);
    return undefined;
  }

  return record;
}

function trustsProxyHeaders() {
  return /^(1|true|yes)$/i.test(process.env.FORGEOS_TRUSTED_PROXY_HEADERS?.trim() ?? "");
}
