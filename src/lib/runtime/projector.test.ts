import { describe, expect, it } from "vitest";
import { createDemoSnapshot, createEmptyForgeSnapshot } from "@/lib/mock/seed";
import { projectOrganizationalState } from "./projector";

describe("projectOrganizationalState", () => {
  it("keeps workers without assigned operations idle when other work completes", () => {
    const snapshot = createDemoSnapshot();
    const projected = projectOrganizationalState({
      ...snapshot,
      operations: snapshot.operations.map((operation) => ({
        ...operation,
        status: "completed",
        progress: 100,
        blockedReason: undefined
      })),
      workers: [
        ...snapshot.workers,
        {
          ...snapshot.workers[0],
          id: "unspawned-default-worker",
          name: "Unspawned Default Worker",
          status: "completed",
          currentTask: "Incorrectly inherited completion"
        }
      ]
    });

    expect(projected.workers.find((worker) => worker.id === "strategy-director")).toMatchObject({ status: "completed" });
    expect(projected.workers.find((worker) => worker.id === "unspawned-default-worker")).toMatchObject({
      status: "idle",
      currentTask: undefined
    });
  });

  it("does not treat an empty fresh forge as deployment ready", () => {
    const projected = projectOrganizationalState(createEmptyForgeSnapshot({ id: "fresh-forge", slug: "fresh", name: "Fresh Forge", prefixEntityIds: true }));

    expect(projected.forge.activePhase).toBe("Strategic Planning");
    expect(projected.workers.every((worker) => worker.status === "idle")).toBe(true);
  });
});
