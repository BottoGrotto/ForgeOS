import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { getBlockingDependencyIds, resolveReadyOperations } from "./scheduler";

describe("scheduler", () => {
  it("models blocking dependencies with explicit edges", () => {
    const snapshot = createDemoSnapshot();

    expect(getBlockingDependencyIds(snapshot, "op-release")).toEqual(["op-qa"]);
  });

  it("does not mark operations ready when blocking dependencies are incomplete", () => {
    const snapshot = createDemoSnapshot();
    const ready = resolveReadyOperations(snapshot).map((operation) => operation.id);

    expect(ready).not.toContain("op-release");
    expect(ready).toContain("op-runtime");
  });
});
