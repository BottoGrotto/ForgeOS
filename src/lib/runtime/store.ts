import { z } from "zod";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { MockRuntime } from "./mock-runtime";
import { calculateOperationReadiness } from "./metrics";
import { InMemoryRuntimePersistence, type RuntimePersistence } from "./persistence";
import { PrismaRuntimePersistence } from "./prisma";
import { projectOrganizationalState, unlockReadyOperations } from "./projector";
import { getBlockingDependencyIds } from "./scheduler";
import type { AgentRuntime, ForgeSnapshot, RuntimeCommand, RuntimeEvent, RuntimeEventDraft } from "./types";

const commandSchema = z.object({
  type: z.enum(["initialize_forge", "start_phase", "run_operation", "run_full_flow", "reset_demo_state", "operator_message"]),
  forgeId: z.string().optional(),
  operationId: z.string().optional(),
  phase: z.string().max(80).optional(),
  message: z.string().max(2000).optional(),
  idempotencyKey: z.string().max(120).optional()
});

export class RuntimeCommandError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RuntimeCommandError";
  }
}

export class RuntimeStore {
  private snapshot: ForgeSnapshot | null = null;
  private loading: Promise<ForgeSnapshot> | null = null;

  constructor(
    private readonly persistence: RuntimePersistence = createDefaultPersistence(),
    private readonly agentRuntime: AgentRuntime = new MockRuntime()
  ) {}

  async getSnapshot() {
    return structuredClone(await this.loadSnapshot());
  }

  async getEvents(afterSequence = 0) {
    const snapshot = await this.loadSnapshot();
    const events = await this.persistence.getEvents(snapshot.forge.id, afterSequence);
    return structuredClone(events);
  }

  async dispatch(input: unknown) {
    const command = commandSchema.parse(input) as RuntimeCommand;

    if (command.idempotencyKey && (await this.persistence.hasIdempotencyKey(command.idempotencyKey))) {
      return this.getSnapshot();
    }

    const nextSnapshot = await this.handleCommand(command);

    if (command.idempotencyKey) {
      await this.persistence.recordIdempotencyKey(command.idempotencyKey);
    }

    this.snapshot = nextSnapshot;
    await this.persistence.saveSnapshot(nextSnapshot);
    return structuredClone(nextSnapshot);
  }

  private async loadSnapshot() {
    if (this.snapshot) {
      return this.snapshot;
    }

    if (!this.loading) {
      this.loading = this.persistence.loadSnapshot().then(async (snapshot) => {
        if (snapshot) {
          return snapshot;
        }

        const seeded = createDemoSnapshot();
        await this.persistence.resetSnapshot(seeded);
        return seeded;
      });
    }

    this.snapshot = await this.loading;
    return this.snapshot;
  }

  private async handleCommand(command: RuntimeCommand) {
    switch (command.type) {
      case "initialize_forge":
      case "reset_demo_state":
        return this.reset(command.type);
      case "start_phase":
        return this.startPhase(command.phase ?? "Autonomous Development");
      case "run_operation":
        return this.runOperation(command.operationId);
      case "run_full_flow":
        return this.runFullFlow();
      case "operator_message":
        return this.addOperatorMessage(command.message ?? "");
    }
  }

  private async reset(commandType: "initialize_forge" | "reset_demo_state") {
    const seeded = createDemoSnapshot();
    const snapshot = appendEvents(seeded, [
      {
        forgeId: seeded.forge.id,
        type: commandType === "reset_demo_state" ? "runtime.reset" : "forge.initialized",
        actorType: "operator",
        targetType: "forge",
        targetId: seeded.forge.id,
        message: commandType === "reset_demo_state" ? "Demo Forge state reset." : "Forge initialized.",
        severity: "success",
        payload: { command: commandType }
      }
    ]);

    this.snapshot = snapshot;
    await this.persistence.resetSnapshot(snapshot);
    return snapshot;
  }

  private async startPhase(phase: string) {
    const snapshot = await this.loadSnapshot();
    return appendEvents(
      {
        ...snapshot,
        forge: {
          ...snapshot.forge,
          activePhase: phase
        }
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "division.status_changed",
          actorType: "operator",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: `Active phase changed to ${phase}.`,
          severity: "info",
          payload: { phase }
        }
      ]
    );
  }

  private async runOperation(operationId?: string) {
    const snapshot = await this.loadSnapshot();
    const operation = snapshot.operations.find((candidate) => candidate.id === operationId);

    if (!operation) {
      throw new RuntimeCommandError("No operation selected.", 400);
    }

    this.assertOperationCanRun(snapshot, operation.id);

    let nextSnapshot = {
      ...snapshot,
      operations: snapshot.operations.map((candidate) =>
        candidate.id === operation.id
          ? {
              ...candidate,
              status: "running" as const,
              progress: Math.max(candidate.progress, 50),
              blockedReason: undefined
            }
          : candidate
      ),
      workers: snapshot.workers.map((worker) =>
        worker.id === operation.workerId
          ? {
              ...worker,
              status: "running" as const,
              currentTask: operation.title
            }
          : worker
      )
    };

    const runtimeEvents: RuntimeEventDraft[] = [];
    for await (const event of this.agentRuntime.runOperation({ forgeId: snapshot.forge.id, operationId: operation.id })) {
      runtimeEvents.push(event);
    }

    nextSnapshot = {
      ...nextSnapshot,
      operations: nextSnapshot.operations.map((candidate) =>
        candidate.id === operation.id
          ? {
              ...candidate,
              status: "completed" as const,
              progress: 100,
              blockedReason: undefined
            }
          : candidate
      )
    };

    nextSnapshot = projectOrganizationalState(nextSnapshot);
    const unlocked = unlockReadyOperations(nextSnapshot);
    nextSnapshot = projectOrganizationalState(unlocked.snapshot);

    return appendEvents(nextSnapshot, [...runtimeEvents, ...unlocked.events]);
  }

  private runFullFlow() {
    const timestamp = new Date().toISOString();
    return this.loadSnapshot().then((snapshot) => {
      const launchArtifact = {
        id: `artifact-launch-${Date.now()}`,
        title: "Launch Checklist",
        type: "launch_checklist",
        divisionId: "release",
        workerId: "release-director",
        operationId: "op-release",
        content: "Demo path validated, release assets finalized, and Forge is deployment ready.",
        status: "finalized" as const,
        version: 1,
        tags: ["release", "demo"],
        fileIds: ["file-qa"],
        createdAt: timestamp,
        updatedAt: timestamp
      };

      const projected = projectOrganizationalState({
        ...snapshot,
        operations: snapshot.operations.map((operation) => ({
          ...operation,
          status: "completed" as const,
          progress: 100,
          blockedReason: undefined
        })),
        workers: snapshot.workers.map((worker) => ({ ...worker, status: "completed" as const })),
        divisions: snapshot.divisions.map((division) => ({ ...division, status: "completed" as const, progress: 100 })),
        artifacts: [...snapshot.artifacts, launchArtifact],
        forge: {
          ...snapshot.forge,
          activePhase: "Deployment Ready"
        }
      });

      return appendEvents(projected, [
        {
          forgeId: snapshot.forge.id,
          type: "operation.completed",
          actorType: "runtime",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Full autonomous flow completed through Release Pass.",
          severity: "success",
          payload: { phase: "Deployment Ready" }
        },
        {
          forgeId: snapshot.forge.id,
          type: "artifact.created",
          actorType: "worker",
          actorId: "release-director",
          targetType: "artifact",
          targetId: launchArtifact.id,
          message: "Release Division generated the launch checklist.",
          severity: "success",
          payload: { artifactId: launchArtifact.id }
        }
      ]);
    });
  }

  private async addOperatorMessage(content: string) {
    const snapshot = await this.loadSnapshot();
    const timestamp = new Date().toISOString();
    const operatorMessage = { id: `msg-${Date.now()}-operator`, role: "operator" as const, content, createdAt: timestamp };
    const response = {
      id: `msg-${Date.now()}-executive`,
      role: "executive" as const,
      content: content.toLowerCase().includes("block")
        ? "Current blocker: testing remains dependent on runtime contract completion. Recommendation: run the runtime operation first."
        : "Executive AI received the command and updated the operational context. The Forge remains in autonomous development.",
      createdAt: timestamp
    };

    return appendEvents(
      {
        ...snapshot,
        messages: [...snapshot.messages, operatorMessage, response]
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "chat.message_added",
          actorType: "operator",
          targetType: "chat",
          message: "Operator message recorded in Executive Console.",
          severity: "info",
          payload: { messageId: operatorMessage.id }
        },
        {
          forgeId: snapshot.forge.id,
          type: "chat.message_added",
          actorType: "executive",
          targetType: "chat",
          message: "Executive AI response generated by mock provider.",
          severity: "success",
          payload: { messageId: response.id }
        }
      ]
    );
  }

  private assertOperationCanRun(snapshot: ForgeSnapshot, operationId: string) {
    const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
    if (!operation) {
      throw new RuntimeCommandError("No operation selected.", 400);
    }

    const readiness = calculateOperationReadiness(operation, snapshot.operations, getBlockingDependencyIds(snapshot, operation.id));

    if (operation.status === "blocked") {
      throw new RuntimeCommandError("Operation is blocked until its dependencies complete.", 409);
    }

    if (operation.status !== "ready") {
      throw new RuntimeCommandError(`Operation cannot run from ${operation.status} status.`, 409);
    }

    if (!readiness.ready) {
      throw new RuntimeCommandError(readiness.reason ?? "Operation is not ready to run.", 409);
    }

    if (operation.workerId && snapshot.operations.some((candidate) => candidate.workerId === operation.workerId && candidate.id !== operation.id && candidate.status === "running")) {
      throw new RuntimeCommandError("Worker is already running another operation.", 409);
    }
  }
}

function appendEvents(snapshot: ForgeSnapshot, drafts: RuntimeEventDraft[]): ForgeSnapshot {
  const createdAt = new Date().toISOString();
  const events: RuntimeEvent[] = drafts.map((draft, index) => ({
    ...draft,
    id: `event-${Date.now()}-${snapshot.lastEventSequence + index + 1}`,
    sequence: snapshot.lastEventSequence + index + 1,
    createdAt
  }));

  return {
    ...snapshot,
    events: [...snapshot.events, ...events],
    lastEventSequence: snapshot.lastEventSequence + events.length
  };
}

function createDefaultPersistence(): RuntimePersistence {
  if (process.env.DATABASE_URL) {
    return new PrismaRuntimePersistence();
  }

  return new InMemoryRuntimePersistence(createDemoSnapshot());
}

export const runtimeStore = new RuntimeStore();
