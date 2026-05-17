import { describe, expect, it } from "vitest";
import { normalizeVirtualPath } from "./paths";

describe("normalizeVirtualPath", () => {
  it("normalizes safe virtual paths", () => {
    expect(normalizeVirtualPath("./docs//project-plan.md")).toBe("docs/project-plan.md");
  });

  it("rejects real filesystem escape paths", () => {
    expect(() => normalizeVirtualPath("../secrets.env")).toThrow("Invalid virtual file path");
    expect(() => normalizeVirtualPath("/etc/passwd")).toThrow("Invalid virtual file path");
    expect(() => normalizeVirtualPath("C:\\Users\\secret")).toThrow("Invalid virtual file path");
  });
});
