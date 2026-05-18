import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRuntimePersistence } from "./persistence";
import { RuntimeStore } from "./store";

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
});

async function createTempStorePath() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forgeos-runtime-"));
  tempDirs.push(dir);
  return path.join(dir, "runtime-store.json");
}
