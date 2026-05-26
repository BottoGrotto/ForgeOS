import { parseRetryAfter } from "./provider-throttle";
import type { AgentRunUsage, AgentRuntime, ProviderCapabilities, ProviderPromptPackage, RunOperationInput, RuntimeEventDraft } from "./types";

type FetchLike = typeof fetch;

export interface OpenClawRuntimeConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  fetchFn?: FetchLike;
  maxRetries?: number;
}

export class OpenClawRuntime implements AgentRuntime {
  private readonly endpoint: string;
  private readonly model?: string;
  private readonly fetchFn: FetchLike;
  private readonly maxRetries: number;
  private readonly activeRequests = new Map<string, AbortController>();

  constructor(private readonly config: OpenClawRuntimeConfig = {}) {
    this.endpoint = config.endpoint ?? process.env.FORGEOS_OPENCLAW_ENDPOINT ?? "";
    this.model = config.model ?? process.env.FORGEOS_OPENCLAW_MODEL;
    this.fetchFn = config.fetchFn ?? fetch;
    this.maxRetries = Math.max(0, config.maxRetries ?? 2);
  }

  provider() {
    return "openclaw" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: false,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    if (!this.endpoint) {
      yield failed(input, "OpenClaw provider is not configured.");
      return;
    }

    const abortController = new AbortController();
    this.activeRequests.set(input.operationId, abortController);
    const response = await this.postWithRetries(createOpenClawRequest(input.providerPrompt), abortController.signal).finally(() => {
      if (this.activeRequests.get(input.operationId) === abortController) {
        this.activeRequests.delete(input.operationId);
      }
    });
    if (!response.ok) {
      yield failed(input, response.message, { rateLimit: response.rateLimit });
      return;
    }

    const body = response.body && typeof response.body === "object" && !Array.isArray(response.body) ? (response.body as Record<string, unknown>) : {};
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "OpenClaw completed the run.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        externalRunId: typeof body.id === "string" ? body.id : undefined,
        providerMetadata: {
          ...(this.model ? { model: this.model } : {}),
          requestCount: response.requestCount
        },
        usage: toUsage(body.usage, response.requestCount),
        rateLimit: response.rateLimit,
        outputs: body.outputs && typeof body.outputs === "object" && !Array.isArray(body.outputs) ? body.outputs : {}
      }
    };
  }

  async cancelOperation(operationId: string) {
    this.activeRequests.get(operationId)?.abort();
    this.activeRequests.delete(operationId);
    return Promise.resolve();
  }

  private async postWithRetries(body: unknown, signal?: AbortSignal) {
    let requestCount = 0;
    let rateLimit: Record<string, unknown> | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      requestCount += 1;
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ?? process.env.FORGEOS_OPENCLAW_API_KEY ? { authorization: `Bearer ${this.config.apiKey ?? process.env.FORGEOS_OPENCLAW_API_KEY}` } : {})
        },
        body: JSON.stringify(body),
        signal
      });

      if (response.status !== 429) {
        if (!response.ok) {
          return { ok: false as const, message: `OpenClaw provider failed with HTTP ${response.status}.`, requestCount, rateLimit };
        }
        return { ok: true as const, body: await response.json(), requestCount, rateLimit };
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      rateLimit = {
        quotaSource: "provider",
        retryAfterMs,
        attempts: requestCount,
        terminalReason: attempt >= this.maxRetries ? "retry_exhausted" : undefined
      };
      if (attempt >= this.maxRetries) {
        return { ok: false as const, message: "OpenClaw provider rate limit retry budget exhausted.", requestCount, rateLimit };
      }
      await delay(Math.min(retryAfterMs ?? 1000, 2000));
    }

    return { ok: false as const, message: "OpenClaw provider failed.", requestCount, rateLimit };
  }

  private createOpenClawRequest(providerPrompt: ProviderPromptPackage) {
    return createOpenClawRequest(providerPrompt, this.model);
  }
}

export function createOpenClawRequest(providerPrompt: ProviderPromptPackage, model?: string) {
  return {
    ...(model ? { model } : {}),
    providerPrompt
  };
}

function toUsage(value: unknown, requestCount: number): AgentRunUsage {
  const usage = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    inputTokens: readNumber(usage.inputTokens),
    outputTokens: readNumber(usage.outputTokens),
    cachedInputTokens: readNumber(usage.cachedInputTokens),
    costMicros: readNumber(usage.costMicros),
    costSource: usage.costSource === "provider" || usage.costSource === "estimated" ? usage.costSource : "unknown",
    requestCount
  };
}

function failed(input: RunOperationInput, message: string, payload: Record<string, unknown> = {}): RuntimeEventDraft {
  return {
    forgeId: input.forgeId,
    type: "run.failed",
    actorType: "runtime",
    targetType: "run",
    message,
    severity: "error",
    payload: { operationId: input.operationId, ...payload }
  };
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
