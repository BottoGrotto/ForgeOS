import type { AgentRuntime, ProviderCapabilities, RunOperationInput, RuntimeEventDraft } from "./types";

export class MockRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "operation.started",
      actorType: "runtime",
      targetType: "operation",
      targetId: input.operationId,
      message: "Mock runtime started operation execution.",
      severity: "info",
      payload: { forgeId: input.forgeId, operationId: input.operationId }
    };

    yield {
      forgeId: input.forgeId,
      type: "operation.completed",
      actorType: "runtime",
      targetType: "operation",
      targetId: input.operationId,
      message: "Mock runtime completed operation execution.",
      severity: "success",
      payload: { forgeId: input.forgeId, operationId: input.operationId }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}
