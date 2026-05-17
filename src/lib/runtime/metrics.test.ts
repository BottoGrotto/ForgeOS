import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { deriveForgeMetrics } from "./metrics";

describe("deriveForgeMetrics", () => {
  it("derives progress and operational counts from snapshot records", () => {
    const snapshot = createDemoSnapshot();
    const metrics = deriveForgeMetrics(snapshot);

    expect(metrics.progress).toBeGreaterThan(40);
    expect(metrics.activeWorkers).toBe(4);
    expect(metrics.blockedOperations).toBe(1);
    expect(metrics.generatedAssets).toBe(snapshot.artifacts.length);
  });

  it("penalizes deployment readiness for blocked operations", () => {
    const snapshot = createDemoSnapshot();
    const original = deriveForgeMetrics(snapshot).deploymentReadiness;
    const withMoreBlockers = {
      ...snapshot,
      operations: snapshot.operations.map((operation) => ({ ...operation, status: "blocked" as const }))
    };

    expect(deriveForgeMetrics(withMoreBlockers).deploymentReadiness).toBeLessThan(original);
  });
});
