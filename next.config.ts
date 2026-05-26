import type { NextConfig } from "next";

type SecurityHeader = {
  key: string;
  value: string;
};

const createContentSecurityPolicy = (
  environment: string | undefined = process.env.NODE_ENV
) => {
  const isProduction = environment === "production";
  const scriptSrc = isProduction
    ? "script-src 'self'"
    : "script-src 'self' 'unsafe-eval' 'unsafe-inline'";

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ");
};

export const createSecurityHeaders = (
  environment: string | undefined = process.env.NODE_ENV
): SecurityHeader[] => [
  {
    key: "Content-Security-Policy",
    value: createContentSecurityPolicy(environment)
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" }
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: createSecurityHeaders() }];
  }
};

export default nextConfig;
