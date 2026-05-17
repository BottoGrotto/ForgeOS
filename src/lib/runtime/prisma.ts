import { Prisma, PrismaClient } from "@prisma/client";
import type { ForgeSnapshot, RuntimeEvent } from "./types";
import type { RuntimePersistence } from "./persistence";

const globalForPrisma = globalThis as unknown as { forgePrisma?: PrismaClient };

export const prisma = globalForPrisma.forgePrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.forgePrisma = prisma;
}

export class PrismaEventStore {
  constructor(private readonly client: PrismaClient) {}

  async getEvents(forgeId: string, afterSequence: number): Promise<RuntimeEvent[]> {
    const events = await this.client.runtimeEvent.findMany({
      where: {
        forgeId,
        sequence: {
          gt: afterSequence
        }
      },
      orderBy: {
        sequence: "asc"
      }
    });

    return events.map((event) => ({
      id: event.id,
      forgeId: event.forgeId,
      sequence: event.sequence,
      type: event.type as RuntimeEvent["type"],
      actorType: event.actorType,
      actorId: event.actorId ?? undefined,
      targetType: event.targetType ?? undefined,
      targetId: event.targetId ?? undefined,
      message: event.message,
      severity: event.severity,
      payload: event.payload as Record<string, unknown>,
      createdAt: event.createdAt.toISOString()
    }));
  }
}

export class PrismaSnapshotStore {
  constructor(private readonly client: PrismaClient) {}

  async loadActiveSnapshot(): Promise<ForgeSnapshot | null> {
    const snapshot = await this.client.forgeSnapshot.findFirst({
      where: {
        forge: {
          slug: "demo",
          status: "active"
        }
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    return snapshot?.payload ? (snapshot.payload as unknown as ForgeSnapshot) : null;
  }

  async replaceSnapshot(snapshot: ForgeSnapshot) {
    await this.client.$transaction(async (tx) => {
      await tx.forge.deleteMany({
        where: {
          slug: snapshot.forge.slug
        }
      });

      await writeSnapshot(tx, snapshot);
    });
  }

  async saveSnapshot(snapshot: ForgeSnapshot) {
    await this.client.$transaction(async (tx) => {
      await tx.forge.upsert({
        where: {
          id: snapshot.forge.id
        },
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

      await tx.forgeSnapshot.create({
        data: {
          forgeId: snapshot.forge.id,
          lastEventSequence: snapshot.lastEventSequence,
          schemaVersion: snapshot.schemaVersion,
          payload: toJson(snapshot)
        }
      });
    });
  }
}

export class PrismaRuntimePersistence implements RuntimePersistence {
  private readonly events: PrismaEventStore;
  private readonly snapshots: PrismaSnapshotStore;

  constructor(private readonly client: PrismaClient = prisma) {
    this.events = new PrismaEventStore(client);
    this.snapshots = new PrismaSnapshotStore(client);
  }

  async loadSnapshot() {
    return this.snapshots.loadActiveSnapshot();
  }

  async saveSnapshot(snapshot: ForgeSnapshot) {
    await this.snapshots.replaceSnapshot(snapshot);
  }

  async resetSnapshot(snapshot: ForgeSnapshot) {
    await this.client.runtimeCommandLedger.deleteMany();
    await this.snapshots.replaceSnapshot(snapshot);
  }

  async getEvents(forgeId: string, afterSequence: number) {
    return this.events.getEvents(forgeId, afterSequence);
  }

  async hasIdempotencyKey(key: string) {
    const record = await this.client.runtimeCommandLedger.findUnique({
      where: {
        key
      }
    });

    return Boolean(record);
  }

  async recordIdempotencyKey(key: string) {
    await this.client.runtimeCommandLedger.create({
      data: {
        key
      }
    });
  }
}

type TransactionClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function writeSnapshot(tx: TransactionClient, snapshot: ForgeSnapshot) {
  await tx.forge.create({
    data: {
      id: snapshot.forge.id,
      slug: snapshot.forge.slug,
      name: snapshot.forge.name,
      tagline: snapshot.forge.tagline,
      status: snapshot.forge.status,
      activePhase: snapshot.forge.activePhase,
      divisions: {
        create: snapshot.divisions.map((division) => ({
          id: division.id,
          name: division.name,
          objective: division.objective,
          status: division.status,
          progress: division.progress,
          order: division.order
        }))
      },
      workers: {
        create: snapshot.workers.map((worker) => ({
          id: worker.id,
          divisionId: worker.divisionId,
          name: worker.name,
          role: worker.role,
          status: worker.status,
          currentTask: worker.currentTask,
          contextManifest: toJson(worker.contextManifest)
        }))
      },
      operations: {
        create: snapshot.operations.map((operation) => ({
          id: operation.id,
          divisionId: operation.divisionId,
          workerId: operation.workerId,
          title: operation.title,
          description: operation.description,
          status: operation.status,
          priority: operation.priority,
          progress: operation.progress,
          blockedReason: operation.blockedReason,
          retryCount: operation.retryCount
        }))
      },
      artifacts: {
        create: snapshot.artifacts.map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          type: artifact.type,
          divisionId: artifact.divisionId,
          workerId: artifact.workerId,
          operationId: artifact.operationId,
          content: artifact.content,
          status: artifact.status,
          version: artifact.version,
          tags: artifact.tags
        }))
      },
      virtualFiles: {
        create: snapshot.files.map((file) => ({
          id: file.id,
          path: file.path,
          content: file.content,
          status: file.status,
          version: file.version,
          divisionId: file.divisionId,
          workerId: file.workerId,
          operationId: file.operationId
        }))
      },
      handoffs: {
        create: snapshot.handoffs.map((handoff) => ({
          id: handoff.id,
          fromDivisionId: handoff.fromDivisionId,
          toDivisionId: handoff.toDivisionId,
          summary: handoff.summary,
          deliverables: handoff.deliverables,
          blockers: handoff.blockers,
          requiredContext: handoff.requiredContext,
          confidence: handoff.confidence,
          createdAt: handoff.createdAt
        }))
      },
      messages: {
        create: snapshot.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt
        }))
      },
      events: {
        create: snapshot.events.map((event) => ({
          id: event.id,
          sequence: event.sequence,
          type: event.type,
          actorType: event.actorType,
          actorId: event.actorId,
          targetType: event.targetType,
          targetId: event.targetId,
          message: event.message,
          severity: event.severity,
          payload: toJson(event.payload),
          createdAt: event.createdAt
        }))
      },
      snapshots: {
        create: {
          lastEventSequence: snapshot.lastEventSequence,
          schemaVersion: snapshot.schemaVersion,
          payload: toJson(snapshot)
        }
      }
    }
  });

  await tx.operationDependency.createMany({
    data: snapshot.dependencies.map((dependency) => ({
      id: dependency.id,
      forgeId: snapshot.forge.id,
      operationId: dependency.operationId,
      dependsOnOperationId: dependency.dependsOnOperationId,
      type: dependency.type
    }))
  });

  const artifactFiles = snapshot.files.flatMap((file) =>
    file.artifactIds.map((artifactId) => ({
      artifactId,
      virtualFileId: file.id
    }))
  );

  if (artifactFiles.length > 0) {
    await tx.artifactFile.createMany({
      data: artifactFiles
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
