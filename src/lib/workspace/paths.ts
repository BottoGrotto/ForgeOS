const unsafeSegmentPattern = /(^|\/)\.\.(\/|$)|^\/|^[a-zA-Z]:|\\/;

export function normalizeVirtualPath(path: string) {
  const trimmed = path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");

  if (!trimmed || unsafeSegmentPattern.test(trimmed)) {
    throw new Error("Invalid virtual file path");
  }

  return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
}
