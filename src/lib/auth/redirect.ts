const DEFAULT_OPERATOR_PATH = "/forges";

export function sanitizeNextPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return DEFAULT_OPERATOR_PATH;
  }

  try {
    const parsed = new URL(value, "http://forgeos.local");
    if (parsed.origin !== "http://forgeos.local" || parsed.pathname.startsWith("/api/")) {
      return DEFAULT_OPERATOR_PATH;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_OPERATOR_PATH;
  }
}
