import { type ZodError, type ZodIssueCode, type ZodType } from "zod";

const DEFAULT_MAX_ISSUES = 8;
const DEFAULT_MAX_MESSAGE_LENGTH = 240;

export type JsonParseFailure = {
  readonly code: "invalid_json";
  readonly message: string;
};

export type JsonParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: JsonParseFailure };

export type StructuredOutputIssue = {
  readonly path: string;
  readonly message: string;
  readonly code: ZodIssueCode;
};

export type SchemaValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly StructuredOutputIssue[] };

export type StructuredOutputDiagnostic =
  | {
      readonly kind: "structured_output.parse_failed";
      readonly stage?: string;
      readonly message: string;
      readonly code: JsonParseFailure["code"];
    }
  | {
      readonly kind: "structured_output.validation_failed";
      readonly stage?: string;
      readonly message: string;
      readonly issues: readonly StructuredOutputIssue[];
    };

type SummaryOptions = {
  readonly maxIssues?: number;
  readonly maxMessageLength?: number;
};

type DiagnosticOptions = {
  readonly stage?: string;
  readonly maxMessageLength?: number;
};

export function parseJsonSafe<T = unknown>(text: string): JsonParseResult<T> {
  try {
    return {
      ok: true,
      value: JSON.parse(text) as T
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_json",
        message: "Invalid JSON"
      }
    };
  }
}

export function summarizeZodError(error: ZodError, options: SummaryOptions = {}): readonly StructuredOutputIssue[] {
  const maxIssues = Math.max(1, options.maxIssues ?? DEFAULT_MAX_ISSUES);
  const maxMessageLength = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;

  return error.issues.slice(0, maxIssues).map((issue) => ({
    path: formatIssuePath(issue.path),
    message: sanitizeDiagnosticText(issue.message, maxMessageLength),
    code: issue.code
  }));
}

export function validateWithSchema<T>(value: unknown, schema: ZodType<T>): SchemaValidationResult<T> {
  const result = schema.safeParse(value);

  if (result.success) {
    return {
      ok: true,
      value: result.data
    };
  }

  return {
    ok: false,
    issues: summarizeZodError(result.error)
  };
}

export function createParseFailureDiagnostic(
  error: JsonParseFailure,
  options: DiagnosticOptions = {}
): StructuredOutputDiagnostic {
  return stripUndefined({
    kind: "structured_output.parse_failed",
    stage: options.stage,
    message: sanitizeDiagnosticText(error.message, options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH),
    code: error.code
  });
}

export function createValidationFailureDiagnostic(
  issues: readonly StructuredOutputIssue[],
  options: DiagnosticOptions = {}
): StructuredOutputDiagnostic {
  return stripUndefined({
    kind: "structured_output.validation_failed",
    stage: options.stage,
    message: sanitizeDiagnosticText("Structured output failed schema validation", options.maxMessageLength),
    issues: issues.map((issue) => ({
      path: issue.path,
      message: sanitizeDiagnosticText(issue.message, options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH),
      code: issue.code
    }))
  });
}

export function sanitizeDiagnosticText(text: string, maxLength = DEFAULT_MAX_MESSAGE_LENGTH): string {
  const normalized = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const boundedMaxLength = Math.max(3, maxLength);

  if (normalized.length <= boundedMaxLength) {
    return normalized;
  }

  return `${normalized.slice(0, boundedMaxLength - 3)}...`;
}

function formatIssuePath(path: readonly (string | number)[]): string {
  return path.map(String).join(".");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
