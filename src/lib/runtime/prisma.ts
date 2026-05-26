import { Prisma, PrismaClient } from "@prisma/client";
import { isActiveRun } from "./runs";
import type { ForgeSnapshot, RuntimeEvent } from "./types";
import { normalizeSnapshot, type ForgeSummary, type GitHubOAuthConnection, type RuntimePersistence, type RuntimeRunClaim } from "./persistence";

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

  async listActiveForges(): Promise<ForgeSummary[]> {
    return this.client.forge.findMany({
      where: {
        status: {
          not: "archived"
        }
      },
      orderBy: {
        name: "asc"
      },
      select: {
        id: true,
        slug: true,
        name: true,
        tagline: true,
        status: true,
        activePhase: true
      }
    });
  }

  async loadActiveSnapshot(forgeSlug: string): Promise<ForgeSnapshot | null> {
    const snapshot = await this.client.forgeSnapshot.findFirst({
      where: {
        forge: {
          slug: forgeSlug,
          status: {
            not: "archived"
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    return snapshot?.payload ? normalizeSnapshot(snapshot.payload as unknown as ForgeSnapshot) : null;
  }

  async replaceSnapshot(snapshot: ForgeSnapshot) {
    await this.client.$transaction(async (tx) => {
      await upsertForge(tx, snapshot);
      await deleteStaleRunClaims(tx, snapshot);
      await deleteSnapshotGraph(tx, snapshot.forge.id);
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
  readonly mode = "database" as const;
  private readonly events: PrismaEventStore;
  private readonly snapshots: PrismaSnapshotStore;

  constructor(private readonly client: PrismaClient = prisma) {
    this.events = new PrismaEventStore(client);
    this.snapshots = new PrismaSnapshotStore(client);
  }

  async listForges() {
    return this.snapshots.listActiveForges();
  }

  async loadSnapshot(forgeSlug: string) {
    return this.snapshots.loadActiveSnapshot(forgeSlug);
  }

  async saveSnapshot(snapshot: ForgeSnapshot) {
    await this.snapshots.replaceSnapshot(snapshot);
  }

  async resetSnapshot(snapshot: ForgeSnapshot) {
    await this.client.runtimeCommandLedger.deleteMany({
      where: {
        key: {
          startsWith: `${snapshot.forge.id}:`
        }
      }
    });
    await this.snapshots.replaceSnapshot(snapshot);
  }

  async deleteForge(forgeSlug: string) {
    const forge = await this.client.forge.findUnique({ where: { slug: forgeSlug }, select: { id: true } });
    if (!forge) {
      return false;
    }
    await this.client.$transaction(async (tx) => {
      await tx.runtimeCommandLedger.deleteMany({
        where: {
          key: {
            startsWith: `${forge.id}:`
          }
        }
      });
      await tx.agentRunClaim.deleteMany({ where: { forgeId: forge.id } });
      await tx.forge.delete({ where: { id: forge.id } });
    });
    return true;
  }

  async getEvents(forgeId: string, afterSequence: number) {
    return this.events.getEvents(forgeId, afterSequence);
  }

  async hasIdempotencyKey(forgeId: string, key: string) {
    const record = await this.client.runtimeCommandLedger.findUnique({
      where: {
        key: scopedKey(forgeId, key)
      }
    });

    return Boolean(record);
  }

  async recordIdempotencyKey(forgeId: string, key: string) {
    await this.client.runtimeCommandLedger.create({
      data: {
        key: scopedKey(forgeId, key)
      }
    });
  }

  async loadGitHubConnection(forgeId: string): Promise<GitHubOAuthConnection | null> {
    const connection = await this.client.gitHubOAuthConnection.findUnique({ where: { forgeId } });
    return connection
      ? {
          forgeId: connection.forgeId,
          accountLogin: connection.accountLogin,
          accountId: connection.accountId,
          scopes: connection.scopes,
          tokenType: connection.tokenType,
          encryptedAccessToken: connection.encryptedAccessToken,
          connectedAt: connection.connectedAt.toISOString(),
          updatedAt: connection.updatedAt.toISOString()
        }
      : null;
  }

  async saveGitHubConnection(connection: GitHubOAuthConnection) {
    await this.client.gitHubOAuthConnection.upsert({
      where: { forgeId: connection.forgeId },
      update: {
        accountLogin: connection.accountLogin,
        accountId: connection.accountId,
        scopes: connection.scopes,
        tokenType: connection.tokenType,
        encryptedAccessToken: connection.encryptedAccessToken,
        connectedAt: new Date(connection.connectedAt)
      },
      create: {
        forgeId: connection.forgeId,
        accountLogin: connection.accountLogin,
        accountId: connection.accountId,
        scopes: connection.scopes,
        tokenType: connection.tokenType,
        encryptedAccessToken: connection.encryptedAccessToken,
        connectedAt: new Date(connection.connectedAt)
      }
    });
  }

  async deleteGitHubConnection(forgeId: string) {
    await this.client.gitHubOAuthConnection.deleteMany({ where: { forgeId } });
  }

  async clear() {
    await this.client.$transaction(async (tx) => {
      await tx.runtimeCommandLedger.deleteMany();
      await tx.agentRunClaim.deleteMany();
      await tx.forge.deleteMany();
    });
  }

  async claimRun(claim: RuntimeRunClaim) {
    try {
      return await this.client.$transaction(async (tx) => {
        const now = new Date();
        await tx.agentRunClaim.deleteMany({
          where: {
            forgeId: claim.forgeId,
            leaseExpiresAt: {
              lte: now
            }
          }
        });
        const conflicting = await tx.agentRunClaim.findFirst({
          where: {
            forgeId: claim.forgeId,
            OR: [
              { operationId: claim.operationId },
              ...(claim.workerId ? [{ workerId: claim.workerId }] : [])
            ]
          }
        });
        if (conflicting) {
          return false;
        }
        await tx.agentRunClaim.create({
          data: {
            forgeId: claim.forgeId,
            runId: claim.runId,
            operationId: claim.operationId,
            workerId: claim.workerId,
            provider: claim.provider,
            claimedBy: claim.claimedBy,
            leaseExpiresAt: new Date(claim.leaseExpiresAt)
          }
        });
        return true;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return false;
      }
      throw error;
    }
  }

  async heartbeatRunClaim(runId: string, leaseExpiresAt: string) {
    await this.client.agentRunClaim.updateMany({
      where: { runId },
      data: {
        leaseExpiresAt: new Date(leaseExpiresAt),
        heartbeatAt: new Date()
      }
    });
  }

  async releaseRunClaim(runId: string) {
    await this.client.agentRunClaim.deleteMany({ where: { runId } });
  }
}

type TransactionClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function writeSnapshot(tx: TransactionClient, snapshot: ForgeSnapshot) {
  await tx.division.createMany({
    data: snapshot.divisions.map((division) => ({
      id: division.id,
      forgeId: snapshot.forge.id,
      name: division.name,
      objective: division.objective,
      status: division.status,
      progress: division.progress,
      order: division.order
    }))
  });

  await tx.worker.createMany({
    data: snapshot.workers.map((worker) => ({
      id: worker.id,
      forgeId: snapshot.forge.id,
      divisionId: worker.divisionId,
      name: worker.name,
      role: worker.role,
      status: worker.status,
      currentTask: worker.currentTask,
      contextManifest: toJson(worker.contextManifest),
      externalAgentId: "externalAgentId" in worker ? worker.externalAgentId : undefined,
      provider: "provider" in worker ? worker.provider : undefined,
      providerMetadata: "providerMetadata" in worker && worker.providerMetadata ? toJson(worker.providerMetadata) : undefined
    }))
  });

  await tx.operation.createMany({
    data: snapshot.operations.map((operation) => ({
      id: operation.id,
      forgeId: snapshot.forge.id,
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
  });

  await tx.agentRun.createMany({
    data: snapshot.runs.map((run) => ({
      id: run.id,
      forgeId: snapshot.forge.id,
      operationId: run.operationId,
      workerId: run.workerId,
      provider: run.provider,
      externalRunId: run.externalRunId,
      status: run.status,
      capabilities: toJson(run.capabilities),
      usage: run.usage ? toJson(run.usage) : undefined,
      rateLimit: run.rateLimit ? toJson(run.rateLimit) : undefined,
      providerMetadata: toJson(run.providerMetadata),
      error: run.error,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      failedAt: run.failedAt,
      canceledAt: run.canceledAt
    }))
  });

  await tx.artifact.createMany({
    data: snapshot.artifacts.map((artifact) => ({
      id: artifact.id,
      forgeId: snapshot.forge.id,
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
  });

  await tx.virtualFile.createMany({
    data: snapshot.files.map((file) => ({
      id: file.id,
      forgeId: snapshot.forge.id,
      path: file.path,
      content: file.content,
      status: file.status,
      version: file.version,
      divisionId: file.divisionId,
      workerId: file.workerId,
      operationId: file.operationId
    }))
  });

  if (snapshot.repository) {
    await tx.forgeRepository.create({
      data: {
        id: snapshot.repository.id,
        forgeId: snapshot.forge.id,
        provider: snapshot.repository.provider,
        owner: snapshot.repository.owner,
        repo: snapshot.repository.repo,
        defaultBranch: snapshot.repository.defaultBranch,
        workingBranch: snapshot.repository.workingBranch,
        installationId: snapshot.repository.installationId,
        accountRef: snapshot.repository.accountRef,
        connectedAt: snapshot.repository.connectedAt,
        lastRefreshedAt: snapshot.repository.lastRefreshedAt
      }
    });
  }

  await tx.handoff.createMany({
    data: snapshot.handoffs.map((handoff) => ({
      id: handoff.id,
      forgeId: snapshot.forge.id,
      fromDivisionId: handoff.fromDivisionId,
      toDivisionId: handoff.toDivisionId,
      summary: handoff.summary,
      deliverables: handoff.deliverables,
      blockers: handoff.blockers,
      requiredContext: handoff.requiredContext,
      confidence: handoff.confidence,
      createdAt: handoff.createdAt
    }))
  });

  await tx.executiveMessage.createMany({
    data: snapshot.messages.map((message) => ({
      id: message.id,
      forgeId: snapshot.forge.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    }))
  });

  await tx.runtimeEvent.createMany({
    data: snapshot.events.map((event) => ({
      id: event.id,
      forgeId: snapshot.forge.id,
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
  });

  await tx.forgeSnapshot.create({
    data: {
      forgeId: snapshot.forge.id,
      lastEventSequence: snapshot.lastEventSequence,
      schemaVersion: snapshot.schemaVersion,
      payload: toJson(snapshot)
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

async function upsertForge(tx: TransactionClient, snapshot: ForgeSnapshot) {
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
}

async function deleteStaleRunClaims(tx: TransactionClient, snapshot: ForgeSnapshot) {
  const activeRunIds = snapshot.runs.filter(isActiveRun).map((run) => run.id);
  await tx.agentRunClaim.deleteMany({
    where: {
      forgeId: snapshot.forge.id,
      ...(activeRunIds.length > 0 ? { runId: { notIn: activeRunIds } } : {})
    }
  });
}

async function deleteSnapshotGraph(tx: TransactionClient, forgeId: string) {
  await tx.artifactFile.deleteMany({
    where: {
      artifact: {
        forgeId
      }
    }
  });
  await tx.operationDependency.deleteMany({ where: { forgeId } });
  await tx.agentRun.deleteMany({ where: { forgeId } });
  await tx.artifact.deleteMany({ where: { forgeId } });
  await tx.virtualFile.deleteMany({ where: { forgeId } });
  await tx.forgeRepository.deleteMany({ where: { forgeId } });
  await tx.handoff.deleteMany({ where: { forgeId } });
  await tx.runtimeEvent.deleteMany({ where: { forgeId } });
  await tx.forgeSnapshot.deleteMany({ where: { forgeId } });
  await tx.executiveMessage.deleteMany({ where: { forgeId } });
  await tx.operation.deleteMany({ where: { forgeId } });
  await tx.worker.deleteMany({ where: { forgeId } });
  await tx.division.deleteMany({ where: { forgeId } });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function scopedKey(forgeId: string, key: string) {
  return `${forgeId}:${key}`;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
