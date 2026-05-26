import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createParseFailureDiagnostic,
  createValidationFailureDiagnostic,
  parseJsonSafe,
  summarizeZodError,
  validateWithSchema
} from "./structured-output";

describe("structured output helpers", () => {
  it("parses valid JSON without throwing", () => {
    const result = parseJsonSafe<{ name: string; count: number }>('{"name":"forge","count":3}');

    expect(result).toEqual({
      ok: true,
      value: { name: "forge", count: 3 }
    });
  });

  it("returns a typed failure for invalid JSON without raw output", () => {
    const result = parseJsonSafe('{"token":"secret-value",');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_json");
      expect(result.error.message).toContain("Invalid JSON");
      expect(JSON.stringify(result.error)).not.toContain("secret-value");
    }
  });

  it("validates values with a Zod schema", () => {
    const schema = z.object({
      action: z.literal("create"),
      count: z.number().int().min(1)
    });

    const result = validateWithSchema({ action: "create", count: 2 }, schema);

    expect(result).toEqual({
      ok: true,
      value: { action: "create", count: 2 }
    });
  });

  it("summarizes Zod failures as path, message, and code only", () => {
    const schema = z.object({
      action: z.literal("create"),
      nested: z.object({
        count: z.number().int().min(1)
      })
    });

    const result = validateWithSchema({ action: "delete", nested: { count: 0 } }, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: "action",
          message: expect.any(String),
          code: "invalid_literal"
        },
        {
          path: "nested.count",
          message: expect.any(String),
          code: "too_small"
        }
      ]);
      expect(Object.keys(result.issues[0])).toEqual(["path", "message", "code"]);
    }
  });

  it("sanitizes and truncates diagnostic issue messages", () => {
    const schema = z.string().refine(() => false, {
      message: `bad output ${"x".repeat(120)} secret-tail`
    });
    const parsed = schema.safeParse("raw-model-output");

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issues = summarizeZodError(parsed.error, { maxMessageLength: 32 });
      const diagnostic = createValidationFailureDiagnostic(issues, {
        stage: "provider.response",
        maxMessageLength: 32
      });

      expect(issues).toEqual([
        {
          path: "",
          code: "custom",
          message: "bad output xxxxxxxxxxxxxxxxxx..."
        }
      ]);
      expect(issues[0].message).toHaveLength(32);
      expect(JSON.stringify(diagnostic)).not.toContain("secret-tail");
      expect(JSON.stringify(diagnostic)).not.toContain("raw-model-output");
    }
  });

  it("creates sanitized parse diagnostics for provider metadata", () => {
    const result = parseJsonSafe('{"prompt":"private prompt",');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = createParseFailureDiagnostic(result.error, {
        stage: "provider.response",
        maxMessageLength: 20
      });

      expect(diagnostic).toEqual({
        kind: "structured_output.parse_failed",
        stage: "provider.response",
        message: "Invalid JSON",
        code: "invalid_json"
      });
      expect(JSON.stringify(diagnostic)).not.toContain("private prompt");
    }
  });
});
