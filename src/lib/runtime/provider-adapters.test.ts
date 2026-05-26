import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { assembleRunContext, buildProviderPromptPackage } from "./context";
import { CodexRuntime, createCodexResponsesRequest, selectCodexModelForPrompt } from "./codex-runtime";
import { createOpenClawRequest } from "./openclaw-runtime";
import { parseRetryAfter } from "./provider-throttle";

describe("provider adapters", () => {
  it("serializes only providerPrompt for Codex Responses requests", () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);
    const request = createCodexResponsesRequest(providerPrompt, "gpt-5.2-codex");
    const serialized = JSON.stringify(request);

    expect(serialized).toContain("forgeos-provider-prompt-v1");
    expect(serialized).toContain("docs/project-plan.md");
    expect(request.text.format).toMatchObject({
      type: "json_schema",
      name: "forgeos_worker_outputs",
      strict: true
    });
    expect(request.text.format.schema.required).toContain("recoveryActions");
    expect(request.text.format.schema.required).toContain("questionRequests");
    expect(request.text.format.schema.required).toContain("dependencyRequests");
    expect(request.text.format.schema.properties).toHaveProperty("recoveryActions");
    expect(request.text.format.schema.properties).toHaveProperty("questionRequests");
    expect(request.text.format.schema.properties).toHaveProperty("dependencyRequests");
    expect(serialized).toContain("division lead approval");
    expect(serialized).toContain("questionRequests");
    expect(serialized).toContain("dependencyRequests");
    expect(serialized).toContain("Workers must solve independently first");
    expect(serialized).toContain("attemptsMade");
    expect(serialized).toContain("npm install");
    expect(serialized).toContain("outside the assigned operation scope");
    expect(serialized).not.toContain("accounting");
    expect(serialized).not.toContain("instructionEnvelope");
    expect(serialized).not.toContain("outputSchema");
    expect(serialized).not.toContain("rawPrompt");
    expect(serialized).not.toContain("providerMetadata");
  });

  it("omits Codex web search unless operation policy allows it", () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);
    const request = createCodexResponsesRequest(providerPrompt, "gpt-5.2-codex");

    expect(request).not.toHaveProperty("tools");
  });

  it("adds low-context Codex web search with sanitized allowed domains for allowed operations", () => {
    const context = assembleRunContext(
      {
        ...createDemoSnapshot(),
        operations: createDemoSnapshot().operations.map((operation) =>
          operation.id === "op-runtime"
            ? {
                ...operation,
                webAccessPolicy: "allowed" as const,
                webAccessPurpose: "Verify current API docs.",
                allowedDomains: ["https://docs.example.com/path", "OPENAI.com"]
              }
            : operation
        )
      },
      "op-runtime"
    );
    const providerPrompt = buildProviderPromptPackage(context);
    const request = createCodexResponsesRequest(providerPrompt, "gpt-5.2-codex");

    expect(request).toMatchObject({
      tools: [
        {
          type: "web_search",
          search_context_size: "low",
          filters: { allowed_domains: ["docs.example.com", "openai.com"] }
        }
      ]
    });
  });

  it("serializes only providerPrompt for OpenClaw requests", () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);
    const request = createOpenClawRequest(providerPrompt, "openclaw-coder");
    const serialized = JSON.stringify(request);

    expect(serialized).toContain("forgeos-provider-prompt-v1");
    expect(serialized).not.toContain("accounting");
    expect(serialized).not.toContain("instructionEnvelope");
    expect(serialized).not.toContain("outputSchema");
    expect(serialized).not.toContain("providerMetadata");
  });

  it("routes regular workers and division heads through affordable Codex model tiers", () => {
    const workerContext = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const workerPrompt = buildProviderPromptPackage(workerContext);
    const leadSnapshot = {
      ...createDemoSnapshot(),
      operations: createDemoSnapshot().operations.map((operation) =>
        operation.id === "op-runtime"
          ? {
              ...operation,
              workerId: "eng-director"
            }
          : operation
      )
    };
    const divisionHeadContext = assembleRunContext(leadSnapshot, "op-runtime");
    const divisionHeadPrompt = buildProviderPromptPackage(divisionHeadContext);

    expect(selectCodexModelForPrompt(workerPrompt, "gpt-5.4-mini", "gpt-5.4-mini").model).toBe("gpt-5.4-mini");
    expect(selectCodexModelForPrompt(divisionHeadPrompt, "gpt-5.4-mini", "gpt-5.4-mini").model).toBe("gpt-5.4-mini");
  });

  it("routes simple, standard, and complex Codex tasks to optimized model tiers", () => {
    const simpleSnapshot = {
      ...createDemoSnapshot(),
      operations: createDemoSnapshot().operations.map((operation) =>
        operation.id === "op-runtime"
          ? {
              ...operation,
              title: "Fix README wording",
              description: "Make a simple docs wording update.",
              priority: "normal" as const
            }
          : operation
      )
    };
    const complexSnapshot = {
      ...createDemoSnapshot(),
      operations: createDemoSnapshot().operations.map((operation) =>
        operation.id === "op-runtime"
          ? {
              ...operation,
              title: "Design authentication architecture",
              description: "Review security and database integration risks.",
              priority: "critical" as const
            }
          : operation
      )
    };
    const standardSnapshot = {
      ...createDemoSnapshot(),
      operations: createDemoSnapshot().operations.map((operation) =>
        operation.id === "op-runtime"
          ? {
              ...operation,
              title: "Build landing page",
              description: "Create the first website screen for the project.",
              priority: "normal" as const
            }
          : operation
      )
    };

    const simple = selectCodexModelForPrompt(buildProviderPromptPackage(assembleRunContext(simpleSnapshot, "op-runtime")), "worker-model", "lead-model", {
      fastModel: "fast-model",
      reasoningModel: "reasoning-model"
    });
    const simpleFastOptIn = selectCodexModelForPrompt(buildProviderPromptPackage(assembleRunContext(simpleSnapshot, "op-runtime")), "worker-model", "lead-model", {
      fastModel: "fast-model",
      reasoningModel: "reasoning-model",
      fastWorkersEnabled: true
    });
    const standard = selectCodexModelForPrompt(buildProviderPromptPackage(assembleRunContext(standardSnapshot, "op-runtime")), "worker-model", "lead-model", {
      fastModel: "fast-model",
      reasoningModel: "reasoning-model"
    });
    const complex = selectCodexModelForPrompt(buildProviderPromptPackage(assembleRunContext(complexSnapshot, "op-runtime")), "worker-model", "lead-model", {
      fastModel: "fast-model",
      reasoningModel: "reasoning-model"
    });

    expect(simple).toMatchObject({ model: "worker-model", tier: "worker" });
    expect(simpleFastOptIn).toMatchObject({ model: "fast-model", tier: "fast" });
    expect(standard).toMatchObject({ model: "worker-model", tier: "worker" });
    expect(complex).toMatchObject({ model: "reasoning-model", tier: "reasoning" });
  });

  it("handles Codex 429 retry-after values without leaking request bodies", async () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp-1",
            output_text: JSON.stringify({ artifacts: [{ title: "Adapter Note", type: "note", content: "done" }] }),
            usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    const runtime = new CodexRuntime({ apiKey: "test-key", fetchFn, maxRetries: 1 });
    const events = [];

    for await (const event of runtime.runOperation({ forgeId: "demo-forge", operationId: "op-runtime", context, providerPrompt, instructions: context.instructionEnvelope })) {
      events.push(event);
    }

    const completed = events.find((event) => event.type === "run.completed")!;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(completed.payload).toMatchObject({
      externalRunId: "resp-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 2,
        requestCount: 2
      },
      outputs: {
        artifacts: [expect.objectContaining({ title: "Adapter Note" })]
      }
    });
    expect(JSON.stringify(events)).not.toContain("test-key");
    expect(JSON.stringify(events)).not.toContain("forgeos-provider-prompt-v1");
  });

  it("does not retry non-retryable Codex insufficient quota errors", async () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: "insufficient_quota",
            code: "insufficient_quota",
            message: "You exceeded your current quota, please check your plan and billing details. https://platform.openai.com/docs/guides/error-codes/api-errors"
          }
        }),
        { status: 429, headers: { "content-type": "application/json" } }
      )
    );
    const runtime = new CodexRuntime({ apiKey: "test-key", fetchFn, maxRetries: 6 });
    const events = [];

    for await (const event of runtime.runOperation({ forgeId: "demo-forge", operationId: "op-runtime", context, providerPrompt, instructions: context.instructionEnvelope })) {
      events.push(event);
    }

    const failed = events.find((event) => event.type === "run.failed")!;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(failed.message).toBe("Codex provider quota is insufficient. Check OpenAI billing, project quota, and model access.");
    expect(failed.payload).toMatchObject({
      rateLimit: {
        quotaSource: "billing",
        attempts: 1,
        terminalReason: "insufficient_quota"
      }
    });
    expect(JSON.stringify(events)).not.toContain("test-key");
    expect(JSON.stringify(events)).not.toContain("platform.openai.com");
  });

  it("emits sanitized Codex non-429 provider diagnostics without raw response bodies", async () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: "server_error",
            code: "bad_gateway",
            message: "upstream failed with raw detail https://provider.example/internal"
          }
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      )
    );
    const runtime = new CodexRuntime({ apiKey: "test-key", fetchFn, maxRetries: 0 });
    const events = [];

    for await (const event of runtime.runOperation({ forgeId: "demo-forge", operationId: "op-runtime", context, providerPrompt, instructions: context.instructionEnvelope })) {
      events.push(event);
    }

    const failed = events.find((event) => event.type === "run.failed")!;
    expect(failed.payload).toMatchObject({
      providerMetadata: {
        category: "provider_http_error",
        httpStatus: 502,
        providerErrorCode: "bad_gateway",
        providerErrorType: "server_error"
      }
    });
    expect(JSON.stringify(events)).not.toContain("provider.example/internal");
    expect(JSON.stringify(events)).not.toContain("test-key");
  });

  it("fails fast on Codex provider timeouts with a distinct category", async () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);
    const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(timeoutError);
    const runtime = new CodexRuntime({ apiKey: "test-key", fetchFn, maxRetries: 3, maxRetryWaitMs: 0, requestTimeoutMs: 1000 });
    const events = [];

    for await (const event of runtime.runOperation({ forgeId: "demo-forge", operationId: "op-runtime", context, providerPrompt, instructions: context.instructionEnvelope })) {
      events.push(event);
    }

    const failed = events.find((event) => event.type === "run.failed")!;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(failed.message).toBe("Codex provider request timed out after 1000ms.");
    expect(failed.payload).toMatchObject({
      rateLimit: {
        attempts: 1,
        terminalReason: "provider_timeout"
      },
      providerMetadata: {
        category: "provider_timeout",
        errorName: "TimeoutError",
        requestTimeoutMs: 1000
      }
    });
  });

  it("retries Codex network fetch failures and emits sanitized diagnostics when exhausted", async () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);
    const networkError = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(networkError);
    const runtime = new CodexRuntime({ apiKey: "test-key", fetchFn, maxRetries: 1, maxRetryWaitMs: 0, requestTimeoutMs: 1000 });
    const events = [];

    for await (const event of runtime.runOperation({ forgeId: "demo-forge", operationId: "op-runtime", context, providerPrompt, instructions: context.instructionEnvelope })) {
      events.push(event);
    }

    const failed = events.find((event) => event.type === "run.failed")!;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(failed.message).toBe("Codex provider network request failed after 2 attempts: fetch failed");
    expect(failed.payload).toMatchObject({
      rateLimit: {
        attempts: 2,
        terminalReason: "network_error"
      },
      providerMetadata: {
        category: "network_error",
        errorName: "TypeError",
        errorMessage: "fetch failed",
        causeCode: "ECONNRESET",
        requestTimeoutMs: 1000
      }
    });
    expect(JSON.stringify(events)).not.toContain("test-key");
    expect(JSON.stringify(events)).not.toContain("forgeos-provider-prompt-v1");
  });

  it("parses retry-after seconds and HTTP dates", () => {
    const now = Date.parse("2026-05-25T12:00:00.000Z");

    expect(parseRetryAfter("2", now)).toBe(2000);
    expect(parseRetryAfter("Mon, 25 May 2026 12:00:03 GMT", now)).toBe(3000);
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
  });
});
