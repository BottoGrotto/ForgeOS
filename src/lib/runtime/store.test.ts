import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { RuntimeCommandError, RuntimeStore } from "./store";
import { InMemoryRuntimePersistence } from "./persistence";

function createTestStore() {
  return new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()));
}

describe("runtimeStore", () => {
  it("creates isolated Forges from names with generated slugs", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());

    const first = await runtimeStore.createForge({ name: "Alpha Forge" });
    const second = await runtimeStore.createForge({ name: "Beta Forge" });
    const firstSnapshot = await runtimeStore.getSnapshot(first.slug);
    const secondSnapshot = await runtimeStore.getSnapshot(second.slug);

    expect(first).toMatchObject({ slug: "alpha-forge", name: "Alpha Forge" });
    expect(second).toMatchObject({ slug: "beta-forge", name: "Beta Forge" });
    expect(firstSnapshot.forge.id).not.toBe(secondSnapshot.forge.id);
    expect(firstSnapshot.operations[0].id).not.toBe(secondSnapshot.operations[0].id);
  });

  it("rejects duplicate Forge slugs", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());

    await runtimeStore.createForge({ name: "Alpha Forge" });

    await expect(runtimeStore.createForge({ name: "Alpha   Forge!" })).rejects.toMatchObject({
      status: 409,
      message: "A Forge with this slug already exists."
    });
  });

  it("isolates commands, resets, and idempotency keys per Forge", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    const alpha = await runtimeStore.createForge({ name: "Scoped Alpha" });
    const beta = await runtimeStore.createForge({ name: "Scoped Beta" });
    const alphaRuntime = (await runtimeStore.getSnapshot(alpha.slug)).operations.find((operation) => operation.title === "Implement runtime contracts")!;
    const betaRuntime = (await runtimeStore.getSnapshot(beta.slug)).operations.find((operation) => operation.title === "Implement runtime contracts")!;

    await runtimeStore.dispatch(alpha.slug, { type: "run_operation", operationId: alphaRuntime.id, idempotencyKey: "same-key" });
    const betaAfterSameKey = await runtimeStore.dispatch(beta.slug, { type: "run_operation", operationId: betaRuntime.id, idempotencyKey: "same-key" });
    await runtimeStore.dispatch(alpha.slug, {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "main",
      idempotencyKey: "connect-alpha"
    });
    const resetBeta = await runtimeStore.dispatch(beta.slug, { type: "reset_demo_state", idempotencyKey: "reset-beta" });
    const alphaSnapshot = await runtimeStore.getSnapshot(alpha.slug);

    expect(betaAfterSameKey.operations.find((operation) => operation.id === betaRuntime.id)?.status).toBe("completed");
    expect(alphaSnapshot.repository?.repo).toBe("ForgeOS");
    expect(resetBeta.repository).toBeUndefined();
    expect(alphaSnapshot.repository).toBeDefined();
  });

  it("rejects local storage clearing when persistence is not file backed", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    await runtimeStore.createForge({ name: "Memory Forge" });

    await expect(runtimeStore.clearLocalForges()).rejects.toMatchObject({
      status: 403,
      message: "Local Forge storage reset is available only with file-backed development storage."
    });
    await expect(runtimeStore.listForges()).resolves.toHaveLength(1);
  });

  it("appends ordered events and refreshes snapshot after a runtime command", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset" });
    const before = (await runtimeStore.getSnapshot("demo")).lastEventSequence;
    const snapshot = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "test-op-runtime" });

    expect(snapshot.lastEventSequence).toBeGreaterThan(before);
    expect(snapshot.events.at(-1)?.sequence).toBe(snapshot.lastEventSequence);
  });

  it("deduplicates commands with the same idempotency key", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-2" });
    const first = await runtimeStore.dispatch("demo", { type: "operator_message", message: "Status?", idempotencyKey: "same-key" });
    const second = await runtimeStore.dispatch("demo", { type: "operator_message", message: "Status?", idempotencyKey: "same-key" });

    expect(second.lastEventSequence).toBe(first.lastEventSequence);
  });

  it("rejects blocked operations by default", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-3" });

    await expect(
      runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-tests", idempotencyKey: "blocked-op" })
    ).rejects.toMatchObject({
      status: 409,
      message: "Operation is blocked until its dependencies complete."
    });
  });

  it("unlocks dependent operations after blocking dependencies complete", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-4" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "unlock-runtime" });

    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.status).toBe("completed");
    expect(snapshot.operations.find((operation) => operation.id === "op-tests")?.status).toBe("ready");
    expect(snapshot.events.some((event) => event.type === "operation.ready" && event.targetId === "op-tests")).toBe(true);
  });

  it("projects completed operations into workers, divisions, and forge phase", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-5" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "run_full_flow", idempotencyKey: "complete-flow" });

    expect(snapshot.operations.every((operation) => operation.status === "completed")).toBe(true);
    expect(snapshot.workers.every((worker) => worker.status === "completed")).toBe(true);
    expect(snapshot.divisions.every((division) => division.status === "completed")).toBe(true);
    expect(snapshot.divisions.every((division) => division.progress === 100)).toBe(true);
    expect(snapshot.forge.activePhase).toBe("Deployment Ready");
  });

  it("pauses a forge and marks incomplete work paused", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-6" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-forge" });

    expect(snapshot.forge.status).toBe("paused");
    expect(snapshot.forge.activePhase).toBe("Safe Shutdown");
    expect(snapshot.operations.filter((operation) => operation.status !== "completed").every((operation) => operation.status === "paused")).toBe(true);
    expect(snapshot.workers.filter((worker) => worker.status !== "completed").every((worker) => worker.status === "paused")).toBe(true);
    expect(snapshot.events.at(-1)?.type).toBe("runtime.paused");
  });

  it("keeps shutdown_forge as a safe pause alias", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-7" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "shutdown_forge", idempotencyKey: "shutdown-forge" });

    expect(snapshot.forge.status).toBe("paused");
    expect(snapshot.events.at(-1)?.type).toBe("runtime.paused");
  });

  it("rejects new operation runs while paused", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-8" });
    await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-before-run" });

    await expect(
      runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "run-after-shutdown" })
    ).rejects.toMatchObject({
      status: 409,
      message: "Forge is paused and is not accepting operation runs."
    });
  });

  it("resumes a paused forge and restores eligible work", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-9" });
    await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-before-resume" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "resume_forge", idempotencyKey: "resume-forge" });

    expect(snapshot.forge.status).toBe("active");
    expect(snapshot.forge.activePhase).toBe("Blocked Review");
    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.status).toBe("ready");
    expect(snapshot.operations.find((operation) => operation.id === "op-tests")?.status).toBe("blocked");
    expect(snapshot.operations.find((operation) => operation.id === "op-qa")?.status).toBe("planning");
    expect(snapshot.operations.find((operation) => operation.id === "op-release")?.status).toBe("planning");
    expect(snapshot.operations.filter((operation) => operation.status === "blocked").map((operation) => operation.id)).toEqual(["op-tests"]);
    expect(snapshot.events.at(-1)?.type).toBe("runtime.resumed");
  });

  it("connects a GitHub repository from a normalized URL", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-1" });
    const before = await runtimeStore.getSnapshot("demo");

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      repositoryUrl: "https://github.com/BottoGrotto/ForgeOS.git",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1",
      idempotencyKey: "connect-repository-url"
    });

    expect(snapshot.repository).toMatchObject({
      provider: "github",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1"
    });
    expect(snapshot.repository?.connectedAt).toEqual(expect.any(String));
    expect(snapshot.events.at(-1)?.type).toBe("repository.connected");
    expect(snapshot.events.at(-1)?.targetType).toBe("repository");
    expect(snapshot.files).toEqual(before.files);
  });

  it("connects a GitHub repository from owner and repo metadata", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-metadata" });

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1",
      installationId: "install-123",
      accountRef: "botto-grotto",
      idempotencyKey: "connect-repository-metadata"
    });

    expect(snapshot.repository).toMatchObject({
      provider: "github",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1",
      installationId: "install-123",
      accountRef: "botto-grotto"
    });
  });

  it("updates an existing GitHub repository connection", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-2" });
    await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/old",
      idempotencyKey: "connect-repository-first"
    });

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/new",
      idempotencyKey: "connect-repository-second"
    });

    expect(snapshot.repository?.workingBranch).toBe("forge/new");
    expect(snapshot.events.at(-1)?.type).toBe("repository.connected");
  });

  it("rejects malformed GitHub repository input", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-3" });

    await expect(
      runtimeStore.dispatch("demo", {
        type: "connect_repository",
        repositoryUrl: "https://gitlab.com/BottoGrotto/ForgeOS",
        defaultBranch: "main",
        workingBranch: "main",
        idempotencyKey: "connect-invalid-provider"
      })
    ).rejects.toMatchObject({
      status: 400,
      message: "Only GitHub repository URLs are supported."
    });
  });

  it("disconnects a connected GitHub repository", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-4" });
    await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "main",
      idempotencyKey: "connect-before-disconnect"
    });

    const snapshot = await runtimeStore.dispatch("demo", { type: "disconnect_repository", idempotencyKey: "disconnect-repository" });

    expect(snapshot.repository).toBeUndefined();
    expect(snapshot.events.at(-1)?.type).toBe("repository.disconnected");
  });

  it("refreshes repository context without modifying virtual files", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-5" });
    const connected = await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "main",
      idempotencyKey: "connect-before-refresh"
    });

    const snapshot = await runtimeStore.dispatch("demo", { type: "refresh_repository_context", idempotencyKey: "refresh-repository" });

    expect(snapshot.repository?.lastRefreshedAt).toEqual(expect.any(String));
    expect(snapshot.events.at(-1)?.type).toBe("repository.refreshed");
    expect(snapshot.files).toEqual(connected.files);
  });

  it("marks command errors for callers that need status codes", () => {
    const error = new RuntimeCommandError("No operation selected.", 400);

    expect(error.status).toBe(400);
    expect(error.message).toBe("No operation selected.");
  });
});
