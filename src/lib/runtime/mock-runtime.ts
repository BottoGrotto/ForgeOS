import type { AgentRuntime, ProviderCapabilities, RunOperationInput, RuntimeEventDraft } from "./types";

export class MockRuntime implements AgentRuntime {
  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true
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
      payload: { ...input }
    };

    yield {
      forgeId: input.forgeId,
      type: "operation.completed",
      actorType: "runtime",
      targetType: "operation",
      targetId: input.operationId,
      message: "Mock runtime completed operation execution.",
      severity: "success",
      payload: { ...input }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}
