import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { FileRuntimePersistence, normalizeSnapshot } from "./persistence";
import { PrismaRuntimePersistence } from "./prisma";
import { RuntimeStore } from "./store";
import type { AgentRun, ForgeSnapshot } from "./types";

let tempDirs: string[] = [];

describe("FileRuntimePersistence", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("reloads Forge snapshots and idempotency keys across store instances", async () => {
    const filePath = await createTempStorePath();
    const firstStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    const forge = await firstStore.createForge({ name: "Persistent Forge" });
    await firstStore.dispatch(forge.slug, { type: "operator_message", message: "Status?", idempotencyKey: "persisted-message" });

    const secondStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    const loaded = await secondStore.getSnapshot(forge.slug);
    const repeated = await secondStore.dispatch(forge.slug, { type: "operator_message", message: "Status?", idempotencyKey: "persisted-message" });

    expect(loaded.forge.name).toBe("Persistent Forge");
    expect(loaded.messages.some((message) => message.content === "Status?")).toBe(true);
    expect(repeated.lastEventSequence).toBe(loaded.lastEventSequence);
  });

  it("does not fail concurrent writes from separate file persistence instances", async () => {
    const filePath = await createTempStorePath();
    const firstStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    const secondStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    const forge = await firstStore.createForge({ name: "Concurrent Forge" });

    await Promise.all([
      firstStore.dispatch(forge.slug, { type: "operator_message", message: "First", idempotencyKey: "first-write" }),
      secondStore.dispatch(forge.slug, { type: "operator_message", message: "Second", idempotencyKey: "second-write" })
    ]);

    const loaded = await new RuntimeStore(new FileRuntimePersistence(filePath)).getSnapshot(forge.slug);
    expect(loaded.forge.name).toBe("Concurrent Forge");
  });

  it("keeps the newer persisted snapshot when a stale instance saves later", async () => {
    const filePath = await createTempStorePath();
    const stalePersistence = new FileRuntimePersistence(filePath);
    const firstStore = new RuntimeStore(stalePersistence);
    const forge = await firstStore.createForge({ name: "Stale Guard Forge" });
    const staleSnapshot = await stalePersistence.loadSnapshot(forge.slug);

    const freshStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    await freshStore.dispatch(forge.slug, { type: "operator_message", message: "Fresh write", idempotencyKey: "fresh-write" });

    await stalePersistence.saveSnapshot(staleSnapshot!);

    const reloadedStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    const loaded = await reloadedStore.getSnapshot(forge.slug);
    const repeated = await reloadedStore.dispatch(forge.slug, { type: "operator_message", message: "Fresh write", idempotencyKey: "fresh-write" });

    expect(loaded.messages.some((message) => message.content === "Fresh write")).toBe(true);
    expect(repeated.lastEventSequence).toBe(loaded.lastEventSequence);
  });

  it("preserves snapshots written by another loaded file persistence instance", async () => {
    const filePath = await createTempStorePath();
    const firstPersistence = new FileRuntimePersistence(filePath);
    const firstStore = new RuntimeStore(firstPersistence);
    await firstStore.createForge({ name: "First Forge" });
    await firstPersistence.listForges();

    const secondStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    await secondStore.createForge({ name: "Second Forge" });

    const first = await firstPersistence.loadSnapshot("first-forge");
    await firstPersistence.saveSnapshot(first!);

    const loaded = await new RuntimeStore(new FileRuntimePersistence(filePath)).listForges();
    expect(loaded.map((forge) => forge.slug)).toEqual(["first-forge", "second-forge"]);
  });

  it("clears cached and persisted local Forge state", async () => {
    const filePath = await createTempStorePath();
    const firstStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    const first = await firstStore.createForge({ name: "Clearable First" });
    await firstStore.createForge({ name: "Clearable Second" });
    await firstStore.dispatch(first.slug, { type: "operator_message", message: "Persist me", idempotencyKey: "cleared-key" });

    await firstStore.clearLocalForges();

    const secondStore = new RuntimeStore(new FileRuntimePersistence(filePath));
    const recreated = await secondStore.createForge({ name: "Clearable First" });
    const snapshot = await secondStore.dispatch(recreated.slug, { type: "operator_message", message: "Persist me", idempotencyKey: "cleared-key" });

    expect(await firstStore.listForges()).toEqual([]);
    expect(snapshot.forge.slug).toBe(first.slug);
    expect(snapshot.messages.filter((message) => message.content === "Persist me")).toHaveLength(1);
  });

  it("persists active run claims outside snapshots and rejects active operation conflicts", async () => {
    const filePath = await createTempStorePath();
    const persistence = new FileRuntimePersistence(filePath);
    const snapshot = createDemoSnapshot();
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

    await expect(
      persistence.claimRun?.({
        runId: "run-1",
        forgeId: snapshot.forge.id,
        operationId: "op-1",
        workerId: "worker-1",
        provider: "mock",
        claimedBy: "test",
        leaseExpiresAt
      })
    ).resolves.toBe(true);
    await persistence.saveSnapshot({ ...snapshot, runs: [createActiveRun(snapshot, { id: "run-1", operationId: "op-1", workerId: "worker-1" })] });

    const reloaded = new FileRuntimePersistence(filePath);
    await expect(
      reloaded.claimRun?.({
        runId: "run-2",
        forgeId: snapshot.forge.id,
        operationId: "op-1",
        workerId: "worker-1",
        provider: "mock",
        claimedBy: "test",
        leaseExpiresAt
      })
    ).resolves.toBe(false);
    await reloaded.releaseRunClaim?.("run-1");
    await expect(
      reloaded.claimRun?.({
        runId: "run-2",
        forgeId: snapshot.forge.id,
        operationId: "op-1",
        workerId: "worker-1",
        provider: "mock",
        claimedBy: "test",
        leaseExpiresAt
      })
    ).resolves.toBe(true);
  });

  it("clears stale run claims when a snapshot is replaced so claims can be reacquired", async () => {
    const filePath = await createTempStorePath();
    const persistence = new FileRuntimePersistence(filePath);
    const snapshot = createDemoSnapshot();
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

    await expect(
      persistence.claimRun?.({
        runId: "run-stale",
        forgeId: snapshot.forge.id,
        operationId: "op-1",
        workerId: "worker-1",
        provider: "mock",
        claimedBy: "test",
        leaseExpiresAt
      })
    ).resolves.toBe(true);

    await persistence.resetSnapshot(snapshot);

    const reloaded = new FileRuntimePersistence(filePath);
    await expect(
      reloaded.claimRun?.({
        runId: "run-fresh",
        forgeId: snapshot.forge.id,
        operationId: "op-1",
        workerId: "worker-1",
        provider: "mock",
        claimedBy: "test",
        leaseExpiresAt
      })
    ).resolves.toBe(true);
  });

  it("normalizes legacy snapshots with v1 team-loop defaults", () => {
    const legacy = createDemoSnapshot() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.runs;
    legacy.handoffs = [
      {
        id: "handoff-legacy",
        fromDivisionId: "strategy",
        toDivisionId: "engineering",
        summary: "Legacy handoff",
        deliverables: [],
        blockers: [],
        requiredContext: [],
        confidence: 70,
        createdAt: "2026-05-17T20:00:00.000Z"
      }
    ];
    legacy.messages = [{ id: "msg-legacy", role: "executive", content: "Legacy message", createdAt: "2026-05-17T20:00:00.000Z" }];

    const snapshot = normalizeSnapshot(legacy as never);

    expect(snapshot.schemaVersion).toBe(5);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.proposals).toEqual([]);
    expect(snapshot.handoffs[0]).toMatchObject({ artifactIds: [], fileIds: [], status: "open" });
    expect(snapshot.messages[0]).toMatchObject({ kind: "executive_reply", source: "manual" });
    expect(snapshot.divisions.find((division) => division.id === "engineering")?.leadWorkerId).toBe("eng-director");
    expect(snapshot.workers.find((worker) => worker.id === "eng-director")).toMatchObject({ kind: "lead", managerWorkerId: "executive-ai" });
    expect(snapshot.workers.find((worker) => worker.id === "backend-worker")).toMatchObject({ kind: "worker" });
    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")).toMatchObject({
      routingStage: "worker_ready",
      webAccessPolicy: "none"
    });
  });

  it("backfills the default organization skeleton for legacy fresh snapshots", () => {
    const legacy = createDemoSnapshot();
    const snapshot = normalizeSnapshot({
      ...legacy,
      forge: {
        ...legacy.forge,
        id: "forge-empty",
        slug: "empty",
        name: "Empty Forge",
        tagline: "Fresh Forge workspace.",
        activePhase: "Planning"
      },
      schemaVersion: 5,
      divisions: [],
      workers: [],
      operations: [],
      runs: [],
      dependencies: [],
      artifacts: [],
      files: [],
      handoffs: [],
      messages: [],
      proposals: [],
      events: legacy.events.slice(0, 1)
    });

    expect(snapshot.divisions.map((division) => division.name)).toEqual([
      "Strategy Division",
      "Operations Division",
      "Engineering Division",
      "Presentation Division",
      "QA Division",
      "Release Division"
    ]);
    expect(snapshot.workers).toHaveLength(11);
    expect(snapshot.operations).toEqual([]);
  });
});

describe("PrismaRuntimePersistence", () => {
  it("replaces saved snapshot-owned rows without deleting the Forge or GitHub OAuth connection", async () => {
    const snapshot = createDemoSnapshot();
    const { client, tx } = createMockPrismaClient();

    await new PrismaRuntimePersistence(client).saveSnapshot(snapshot);

    expect(tx.forge.upsert).toHaveBeenCalledWith({
      where: { id: snapshot.forge.id },
      update: {
        slug: snapshot.forge.slug,
        name: snapshot.forge.name,
        tagline: snapshot.forge.tagline,
        status: snapshot.forge.status,
        activePhase: snapshot.forge.activePhase
      },
      create: {
        id: snapshot.forge.id,
        slug: snapshot.forge.slug,
        name: snapshot.forge.name,
        tagline: snapshot.forge.tagline,
        status: snapshot.forge.status,
        activePhase: snapshot.forge.activePhase
      }
    });
    expect(tx.forge.deleteMany).not.toHaveBeenCalled();
    expect(tx.forge.delete).not.toHaveBeenCalled();
    expect(tx.gitHubOAuthConnection.deleteMany).not.toHaveBeenCalled();
    expect(tx.agentRunClaim.deleteMany).toHaveBeenCalledWith({ where: { forgeId: snapshot.forge.id } });
    expect(tx.forgeSnapshot.deleteMany).toHaveBeenCalledWith({ where: { forgeId: snapshot.forge.id } });
    expect(tx.forgeSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        forgeId: snapshot.forge.id,
        lastEventSequence: snapshot.lastEventSequence,
        schemaVersion: snapshot.schemaVersion
      })
    });
  });

  it("keeps active database run claims while purging stale claims during snapshot replacement", async () => {
    const snapshot = createDemoSnapshot();
    const activeSnapshot = { ...snapshot, runs: [createActiveRun(snapshot, { id: "run-active", operationId: "op-1", workerId: "worker-1" })] };
    const { client, tx } = createMockPrismaClient();

    await new PrismaRuntimePersistence(client).saveSnapshot(activeSnapshot);

    expect(tx.agentRunClaim.deleteMany).toHaveBeenCalledWith({
      where: {
        forgeId: snapshot.forge.id,
        runId: { notIn: ["run-active"] }
      }
    });
  });

  it("preserves GitHub OAuth connections during database resets while clearing idempotency keys", async () => {
    const snapshot = createDemoSnapshot();
    const { client, raw, tx } = createMockPrismaClient();

    await new PrismaRuntimePersistence(client).resetSnapshot(snapshot);

    expect(raw.runtimeCommandLedger.deleteMany).toHaveBeenCalledWith({
      where: {
        key: {
          startsWith: `${snapshot.forge.id}:`
        }
      }
    });
    expect(tx.forge.deleteMany).not.toHaveBeenCalled();
    expect(tx.forge.delete).not.toHaveBeenCalled();
    expect(tx.gitHubOAuthConnection.deleteMany).not.toHaveBeenCalled();
    expect(tx.agentRunClaim.deleteMany).toHaveBeenCalledWith({ where: { forgeId: snapshot.forge.id } });
    expect(tx.forge.upsert).toHaveBeenCalled();
  });
});

function createActiveRun(snapshot: ForgeSnapshot, overrides: Pick<AgentRun, "id" | "operationId" | "workerId">): AgentRun {
  return {
    id: overrides.id,
    forgeId: snapshot.forge.id,
    operationId: overrides.operationId,
    workerId: overrides.workerId,
    provider: "mock",
    status: "running",
    capabilities: {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    },
    queuedAt: "2026-05-26T12:00:00.000Z",
    startedAt: "2026-05-26T12:00:01.000Z",
    providerMetadata: {}
  };
}

async function createTempStorePath() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forgeos-runtime-"));
  tempDirs.push(dir);
  return path.join(dir, "runtime-store.json");
}

function createMockPrismaClient() {
  const tx = {
    artifactFile: model("createMany", "deleteMany"),
    operationDependency: model("createMany", "deleteMany"),
    agentRun: model("createMany", "deleteMany"),
    artifact: model("createMany", "deleteMany"),
    virtualFile: model("createMany", "deleteMany"),
    forgeRepository: model("create", "deleteMany"),
    handoff: model("createMany", "deleteMany"),
    runtimeEvent: model("createMany", "deleteMany"),
    forgeSnapshot: model("create", "deleteMany"),
    executiveMessage: model("createMany", "deleteMany"),
    operation: model("createMany", "deleteMany"),
    worker: model("createMany", "deleteMany"),
    division: model("createMany", "deleteMany"),
    forge: model("delete", "deleteMany", "upsert"),
    agentRunClaim: model("deleteMany"),
    gitHubOAuthConnection: model("deleteMany")
  };
  const raw = {
    runtimeCommandLedger: model("deleteMany"),
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx))
  };

  return { client: raw as never, raw, tx };
}

function model<TMethod extends string>(...methods: TMethod[]): Record<TMethod, ReturnType<typeof vi.fn>> {
  return Object.fromEntries(methods.map((method) => [method, vi.fn(async () => undefined)])) as Record<TMethod, ReturnType<typeof vi.fn>>;
}
