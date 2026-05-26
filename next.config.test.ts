import { describe, expect, it } from "vitest";

import { createSecurityHeaders } from "./next.config";

const getContentSecurityPolicy = (environment: string) => {
  const header = createSecurityHeaders(environment).find(
    ({ key }) => key === "Content-Security-Policy"
  );

  if (!header) {
    throw new Error("Content-Security-Policy header is missing");
  }

  return header.value;
};

const getDirective = (policy: string, directiveName: string) =>
  policy
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${directiveName} `));

describe("next security headers", () => {
  it("uses a stricter production content security policy", () => {
    const policy = getContentSecurityPolicy("production");
    const scriptSrc = getDirective(policy, "script-src");

    expect(scriptSrc).toBe("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("keeps Next development script compatibility out of production", () => {
    const policy = getContentSecurityPolicy("development");

    expect(getDirective(policy, "script-src")).toBe(
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
    );
    expect(policy).toContain("object-src 'none'");
  });
});
