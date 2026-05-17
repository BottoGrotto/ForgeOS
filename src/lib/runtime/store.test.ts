import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { RuntimeCommandError, RuntimeStore } from "./store";
import { InMemoryRuntimePersistence } from "./persistence";

function createTestStore() {
  return new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()));
}

describe("runtimeStore", () => {
  it("appends ordered events and refreshes snapshot after a runtime command", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset" });
    const before = (await runtimeStore.getSnapshot()).lastEventSequence;
    const snapshot = await runtimeStore.dispatch({ type: "run_operation", operationId: "op-runtime", idempotencyKey: "test-op-runtime" });

    expect(snapshot.lastEventSequence).toBeGreaterThan(before);
    expect(snapshot.events.at(-1)?.sequence).toBe(snapshot.lastEventSequence);
  });

  it("deduplicates commands with the same idempotency key", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset-2" });
    const first = await runtimeStore.dispatch({ type: "operator_message", message: "Status?", idempotencyKey: "same-key" });
    const second = await runtimeStore.dispatch({ type: "operator_message", message: "Status?", idempotencyKey: "same-key" });

    expect(second.lastEventSequence).toBe(first.lastEventSequence);
  });

  it("rejects blocked operations by default", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset-3" });

    await expect(
      runtimeStore.dispatch({ type: "run_operation", operationId: "op-tests", idempotencyKey: "blocked-op" })
    ).rejects.toMatchObject({
      status: 409,
      message: "Operation is blocked until its dependencies complete."
    });
  });

  it("unlocks dependent operations after blocking dependencies complete", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset-4" });

    const snapshot = await runtimeStore.dispatch({ type: "run_operation", operationId: "op-runtime", idempotencyKey: "unlock-runtime" });

    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.status).toBe("completed");
    expect(snapshot.operations.find((operation) => operation.id === "op-tests")?.status).toBe("ready");
    expect(snapshot.events.some((event) => event.type === "operation.ready" && event.targetId === "op-tests")).toBe(true);
  });

  it("projects completed operations into workers, divisions, and forge phase", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset-5" });

    const snapshot = await runtimeStore.dispatch({ type: "run_full_flow", idempotencyKey: "complete-flow" });

    expect(snapshot.operations.every((operation) => operation.status === "completed")).toBe(true);
    expect(snapshot.workers.every((worker) => worker.status === "completed")).toBe(true);
    expect(snapshot.divisions.every((division) => division.status === "completed")).toBe(true);
    expect(snapshot.divisions.every((division) => division.progress === 100)).toBe(true);
    expect(snapshot.forge.activePhase).toBe("Deployment Ready");
  });

  it("pauses a forge and marks incomplete work paused", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset-6" });

    const snapshot = await runtimeStore.dispatch({ type: "pause_forge", idempotencyKey: "pause-forge" });

    expect(snapshot.forge.status).toBe("paused");
    expect(snapshot.forge.activePhase).toBe("Safe Shutdown");
    expect(snapshot.operations.filter((operation) => operation.status !== "completed").every((operation) => operation.status === "paused")).toBe(true);
    expect(snapshot.workers.filter((worker) => worker.status !== "completed").every((worker) => worker.status === "paused")).toBe(true);
    expect(snapshot.events.at(-1)?.type).toBe("runtime.paused");
  });

  it("keeps shutdown_forge as a safe pause alias", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset-7" });

    const snapshot = await runtimeStore.dispatch({ type: "shutdown_forge", idempotencyKey: "shutdown-forge" });

    expect(snapshot.forge.status).toBe("paused");
    expect(snapshot.events.at(-1)?.type).toBe("runtime.paused");
  });

  it("rejects new operation runs while paused", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset-8" });
    await runtimeStore.dispatch({ type: "pause_forge", idempotencyKey: "pause-before-run" });

    await expect(
      runtimeStore.dispatch({ type: "run_operation", operationId: "op-runtime", idempotencyKey: "run-after-shutdown" })
    ).rejects.toMatchObject({
      status: 409,
      message: "Forge is paused and is not accepting operation runs."
    });
  });

  it("resumes a paused forge and restores eligible work", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch({ type: "reset_demo_state", idempotencyKey: "test-reset-9" });
    await runtimeStore.dispatch({ type: "pause_forge", idempotencyKey: "pause-before-resume" });

    const snapshot = await runtimeStore.dispatch({ type: "resume_forge", idempotencyKey: "resume-forge" });

    expect(snapshot.forge.status).toBe("active");
    expect(snapshot.forge.activePhase).toBe("Blocked Review");
    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.status).toBe("ready");
    expect(snapshot.operations.find((operation) => operation.id === "op-tests")?.status).toBe("blocked");
    expect(snapshot.operations.find((operation) => operation.id === "op-qa")?.status).toBe("planning");
    expect(snapshot.operations.find((operation) => operation.id === "op-release")?.status).toBe("planning");
    expect(snapshot.operations.filter((operation) => operation.status === "blocked").map((operation) => operation.id)).toEqual(["op-tests"]);
    expect(snapshot.events.at(-1)?.type).toBe("runtime.resumed");
  });

  it("marks command errors for callers that need status codes", () => {
    const error = new RuntimeCommandError("No operation selected.", 400);

    expect(error.status).toBe(400);
    expect(error.message).toBe("No operation selected.");
  });
});
