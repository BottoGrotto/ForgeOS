import { parseRetryAfter } from "./provider-throttle";
import type { AgentRunRateLimit, AgentRunUsage, AgentRuntime, ProviderCapabilities, ProviderPromptPackage, RunOperationInput, RuntimeEventDraft } from "./types";

type FetchLike = typeof fetch;
const AFFORDABLE_OPENAI_MODEL = "gpt-5.4-mini";

export interface CodexRuntimeConfig {
  apiKey?: string;
  model?: string;
  fastWorkersEnabled?: boolean;
  endpoint?: string;
  maxRetries?: number;
  maxRetryWaitMs?: number;
  requestTimeoutMs?: number;
  fetchFn?: FetchLike;
}

export class CodexRuntime implements AgentRuntime {
  private readonly workerModel: string;
  private readonly divisionHeadModel: string;
  private readonly fastModel: string;
  private readonly reasoningModel: string;
  private readonly endpoint: string;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly workerRequestTimeoutMs: number;
  private readonly reasoningRequestTimeoutMs: number;
  private readonly fetchFn: FetchLike;
  private readonly activeRequests = new Map<string, AbortController>();

  constructor(private readonly config: CodexRuntimeConfig = {}) {
    this.workerModel = selectAffordableOpenAIModel(process.env.FORGEOS_CODEX_WORKER_MODEL ?? config.model ?? process.env.FORGEOS_CODEX_MODEL ?? AFFORDABLE_OPENAI_MODEL);
    this.divisionHeadModel = selectAffordableOpenAIModel(process.env.FORGEOS_CODEX_DIVISION_HEAD_MODEL ?? process.env.FORGEOS_CODEX_LEAD_MODEL ?? this.workerModel);
    this.fastModel = selectAffordableOpenAIModel(process.env.FORGEOS_CODEX_FAST_MODEL ?? process.env.FORGEOS_CODEX_SMALL_MODEL ?? this.workerModel);
    this.reasoningModel = selectAffordableOpenAIModel(process.env.FORGEOS_CODEX_REASONING_MODEL ?? this.divisionHeadModel);
    this.endpoint = config.endpoint ?? process.env.FORGEOS_CODEX_ENDPOINT ?? "https://api.openai.com/v1/responses";
    this.maxRetries = Math.max(0, config.maxRetries ?? readPositiveInteger(process.env.FORGEOS_CODEX_MAX_RETRIES, 1));
    this.maxRetryWaitMs = Math.max(0, config.maxRetryWaitMs ?? readPositiveInteger(process.env.FORGEOS_CODEX_MAX_RETRY_WAIT_MS, 5000));
    const globalTimeout = config.requestTimeoutMs ?? readPositiveInteger(process.env.FORGEOS_CODEX_REQUEST_TIMEOUT_MS, 0);
    this.workerRequestTimeoutMs = Math.max(1000, globalTimeout || readPositiveInteger(process.env.FORGEOS_CODEX_WORKER_REQUEST_TIMEOUT_MS, 30000));
    this.reasoningRequestTimeoutMs = Math.max(1000, globalTimeout || readPositiveInteger(process.env.FORGEOS_CODEX_REASONING_REQUEST_TIMEOUT_MS, 60000));
    this.fetchFn = config.fetchFn ?? fetch;
  }

  provider() {
    return "codex" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: false,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: true
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    const apiKey = this.config.apiKey ?? process.env.FORGEOS_CODEX_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      yield failed(input, "Codex provider is not configured.");
      return;
    }

    const selection = selectCodexModelForPrompt(input.providerPrompt, this.workerModel, this.divisionHeadModel, {
      fastModel: this.fastModel,
      reasoningModel: this.reasoningModel,
      fastWorkersEnabled: this.config.fastWorkersEnabled ?? process.env.FORGEOS_CODEX_FAST_WORKERS === "1"
    });
    const model = selection.model;
    const requestTimeoutMs = selection.tier === "reasoning" || selection.tier === "lead" ? this.reasoningRequestTimeoutMs : this.workerRequestTimeoutMs;
    const webEnabled = input.providerPrompt.context.operation.webAccessPolicy === "allowed" || input.providerPrompt.context.operation.webAccessPolicy === "required";
    yield progress(input, "Codex request started.", {
      model,
      modelTier: selection.tier,
      modelSelectionReason: selection.reason,
      requestTimeoutMs,
      webEnabled,
      webAccessPolicy: input.providerPrompt.context.operation.webAccessPolicy
    });

    const request = createCodexResponsesRequest(input.providerPrompt, model);
    const abortController = new AbortController();
    this.activeRequests.set(input.operationId, abortController);
    const result = await fetchWithRateLimitRetries(this.fetchFn, this.endpoint, apiKey, request, this.maxRetries, this.maxRetryWaitMs, requestTimeoutMs, abortController.signal).finally(() => {
      if (this.activeRequests.get(input.operationId) === abortController) {
        this.activeRequests.delete(input.operationId);
      }
    });
    if (!result.ok) {
      yield failed(input, result.message, {
        rateLimit: result.rateLimit,
        ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {})
      });
      return;
    }

    const outputs = parseProviderOutputs(result.body);
    const webSources = extractWebSources(result.body);
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Codex completed the run.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        externalRunId: readString(result.body, "id"),
        providerMetadata: {
          model,
          modelTier: selection.tier,
          modelSelectionReason: selection.reason,
          requestCount: result.requestCount,
          webEnabled,
          webUsed: webSources.length > 0,
          webSourceCount: webSources.length,
          webEstimatedTokenImpact: estimateWebTokenImpact(webSources),
          ...(webSources.length > 0 ? { webSources } : {})
        },
        usage: toUsage(result.body, result.requestCount, model, estimateWebTokenImpact(webSources)),
        rateLimit: result.rateLimit,
        outputs
      }
    };
  }

  async cancelOperation(operationId: string) {
    this.activeRequests.get(operationId)?.abort();
    this.activeRequests.delete(operationId);
    return Promise.resolve();
  }
}

export function createCodexResponsesRequest(providerPrompt: ProviderPromptPackage, model: string) {
  const webSearchTool = createWebSearchTool(providerPrompt);
  return {
    model,
    input: [
      {
        role: "system",
        content:
          "You are a ForgeOS worker runtime. Use only the supplied providerPrompt. Return strict JSON with keys artifacts, files, filePatches, requestedFiles, requestedSearches, requestedArtifacts, handoffs, blockers, questionRequests, dependencyRequests, dangerousActions, recoveryActions. Workers must solve independently first: use assigned context, bounded requestedFiles/requestedSearches/requestedArtifacts, existing dependencies, built-in APIs, exact patches, tests, and verification evidence before asking for help. For implementation work, inspect needed project context by returning requestedSearches, requestedFiles, and requestedArtifacts before final outputs, then produce concrete source/design/test files. Use questionRequests only for scope_approval, product_decision, policy_exception, external_authority, or upstream_dependency decisions; include category, attemptsMade, and whySelfSolveInsufficient. Do not ask leads or Executive for ordinary debugging, implementation strategy, runtime logs, test output, or what to try next. Set needsExecutive only when the lead should escalate a valid question to Executive. Stay within the assigned operation scope; if you need files outside the assigned operation scope, ask for division lead approval before reading, patching, rewriting, or creating them. Use dependencyRequests for new packages and explain why built-in APIs or existing dependencies are insufficient. Do not put npm install, pnpm add, yarn add, bun add, or similar install commands in generated package scripts or dangerousActions unless explicitly asking for escalation. Use filePatches with exact { path, find, replace } for small edits to existing files; use files for new files or complete rewrites. Include package scripts that let ForgeOS run the generated project: development checks should expose a fast test/typecheck/smoke path, and QA/release acceptance should expose broader test/typecheck/lint/build/smoke/e2e scripts when applicable. Always include at least one artifact summarizing the completed deliverable unless blocked. Use blockers only for actionable conditions that prevent this operation from completing after in-scope self-solve attempts; include attemptsMade and whySelfSolveInsufficient when self-solve was attempted. Do not emit blockers for informational coordination status such as no currently eligible downstream operations after handoffs are routed. Keep paths relative, sanitized, and project-like, for example app/page.tsx, components/Search.tsx, lib/data.ts, styles/globals.css, docs/plan.md. Do not claim external writes or shell execution; ForgeOS will project outputs into its virtual workspace and run allowlisted verification in a sandbox. If work needs a non-allowlisted shell command, repo write, publish, deploy, credential, or external side effect, declare it in dangerousActions with action, reason, and optional command. Only division leads assigned to lead triage operations may emit recoveryActions."
      },
      {
        role: "user",
        content: JSON.stringify(providerPrompt)
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "forgeos_worker_outputs",
        strict: true,
        schema: workerOutputJsonSchema
      }
    },
    ...(webSearchTool ? { tools: [webSearchTool] } : {})
  };
}

const providerString = { type: "string", maxLength: 20000 } as const;
const providerStringArray = { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 12 } as const;

export const workerOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifacts", "files", "filePatches", "requestedFiles", "requestedSearches", "requestedArtifacts", "handoffs", "blockers", "questionRequests", "dependencyRequests", "dangerousActions", "recoveryActions"],
  properties: {
    artifacts: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "type", "content", "tags"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 160 },
          type: { type: "string", minLength: 1, maxLength: 80 },
          content: providerString,
          tags: providerStringArray
        }
      }
    },
    files: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 240 },
          content: { type: "string", maxLength: 50000 }
        }
      }
    },
    filePatches: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "find", "replace"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 240 },
          find: { type: "string", minLength: 1, maxLength: 20000 },
          replace: { type: "string", maxLength: 50000 }
        }
      }
    },
    requestedFiles: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "path", "reason"],
        properties: {
          id: { type: ["string", "null"], maxLength: 160 },
          path: { type: ["string", "null"], maxLength: 240 },
          reason: { type: ["string", "null"], maxLength: 240 }
        }
      }
    },
    requestedSearches: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "glob", "reason"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 160 },
          glob: { type: ["string", "null"], maxLength: 120 },
          reason: { type: ["string", "null"], maxLength: 240 }
        }
      }
    },
    requestedArtifacts: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "type", "reason"],
        properties: {
          id: { type: ["string", "null"], maxLength: 160 },
          title: { type: ["string", "null"], maxLength: 160 },
          type: { type: ["string", "null"], maxLength: 80 },
          reason: { type: ["string", "null"], maxLength: 240 }
        }
      }
    },
    handoffs: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["toDivisionId", "targetOperationId", "summary", "deliverables", "blockers", "requiredContext", "artifactIds", "fileIds", "confidence"],
        properties: {
          toDivisionId: { type: "string", minLength: 1, maxLength: 120 },
          targetOperationId: { type: ["string", "null"], maxLength: 120 },
          summary: { type: "string", minLength: 1, maxLength: 1000 },
          deliverables: providerStringArray,
          blockers: providerStringArray,
          requiredContext: providerStringArray,
          artifactIds: { type: "array", items: { type: "string", maxLength: 160 }, maxItems: 24 },
          fileIds: { type: "array", items: { type: "string", maxLength: 160 }, maxItems: 24 },
          confidence: { type: "integer", minimum: 0, maximum: 100 }
        }
      }
    },
    blockers: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["reason", "severity", "attemptsMade", "whySelfSolveInsufficient"],
        properties: {
          reason: { type: "string", minLength: 1, maxLength: 1000 },
          severity: { type: "string", enum: ["info", "success", "warning", "error"] },
          attemptsMade: providerStringArray,
          whySelfSolveInsufficient: { type: ["string", "null"], maxLength: 500 }
        }
      }
    },
    questionRequests: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "reason", "category", "scope", "options", "needsExecutive", "recommendedDefault", "attemptsMade", "whySelfSolveInsufficient"],
        properties: {
          question: { type: "string", minLength: 1, maxLength: 500 },
          reason: { type: "string", minLength: 1, maxLength: 500 },
          category: { type: ["string", "null"], enum: ["scope_approval", "product_decision", "policy_exception", "external_authority", "upstream_dependency", null] },
          scope: { type: ["string", "null"], maxLength: 160 },
          options: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label", "description"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 120 },
                label: { type: "string", minLength: 1, maxLength: 160 },
                description: { type: ["string", "null"], maxLength: 240 }
              }
            }
          },
          needsExecutive: { type: "boolean" },
          recommendedDefault: { type: ["string", "null"], maxLength: 500 },
          attemptsMade: providerStringArray,
          whySelfSolveInsufficient: { type: ["string", "null"], maxLength: 500 }
        }
      }
    },
    dangerousActions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "reason", "command"],
        properties: {
          action: { type: "string", minLength: 1, maxLength: 160 },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
          command: { type: ["string", "null"], maxLength: 240 }
        }
      }
    },
    dependencyRequests: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["packageName", "versionRange", "dependencyType", "reason", "usedByFiles", "alternativesConsidered", "requiresExecutive"],
        properties: {
          packageName: { type: "string", minLength: 1, maxLength: 120 },
          versionRange: { type: ["string", "null"], maxLength: 80 },
          dependencyType: { type: "string", enum: ["dependency", "devDependency", "optionalDependency"] },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
          usedByFiles: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 12 },
          alternativesConsidered: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 12 },
          requiresExecutive: { type: "boolean" }
        }
      }
    },
    recoveryActions: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "targetOperationId", "title", "description", "workerId", "reason", "recommendedNextAction"],
        properties: {
          type: { type: "string", enum: ["revise_operation", "create_replacement_operation", "request_more_context", "escalate_to_executive"] },
          targetOperationId: { type: ["string", "null"], maxLength: 120 },
          title: { type: ["string", "null"], maxLength: 160 },
          description: { type: ["string", "null"], maxLength: 1000 },
          workerId: { type: ["string", "null"], maxLength: 120 },
          reason: { type: ["string", "null"], maxLength: 500 },
          recommendedNextAction: { type: ["string", "null"], maxLength: 500 }
        }
      }
    }
  }
} as const;

function createWebSearchTool(providerPrompt: ProviderPromptPackage) {
  const policy = providerPrompt.context.operation.webAccessPolicy;
  if (policy !== "allowed" && policy !== "required") {
    return undefined;
  }
  const allowedDomains = sanitizeAllowedDomains(providerPrompt.context.operation.allowedDomains);
  return {
    type: "web_search",
    search_context_size: "low",
    ...(allowedDomains.length > 0 ? { filters: { allowed_domains: allowedDomains } } : {})
  };
}

export interface CodexModelOptions {
  fastModel?: string;
  reasoningModel?: string;
  fastWorkersEnabled?: boolean;
}

export function selectCodexModelForPrompt(providerPrompt: ProviderPromptPackage, workerModel: string, divisionHeadModel: string, options: CodexModelOptions = {}) {
  const fastModel = options.fastModel ?? workerModel;
  const reasoningModel = options.reasoningModel ?? divisionHeadModel;
  const operationText = [
    providerPrompt.context.operation.title,
    providerPrompt.context.operation.description
  ].join(" ");
  const normalizedOperation = operationText.toLowerCase();
  const isLead = isExecutiveOrDivisionHeadPrompt(providerPrompt);
  const isCritical = providerPrompt.context.operation.priority === "critical";
  const needsWeb = providerPrompt.context.operation.webAccessPolicy === "required";
  const needsDeepReasoning = /\b(architecture|security|threat|auth|database|schema|migration|concurrency|race|debug|root cause|integration|api|parser|scraper|algorithm|performance|system design|lead triage|recovery)\b/i.test(
    normalizedOperation
  );
  const isSmallTask =
    /\b(copy|wording|typo|rename|format|docs?|readme|summary|checklist|style tweak|small|simple)\b/i.test(operationText) &&
    !isCritical &&
    !needsWeb &&
    !/\b(architecture|security|auth|database|schema|migration|concurrency|debug|integration|api|parser|scraper|algorithm|performance|system design|lead triage|recovery)\b/i.test(operationText);

  if (options.fastWorkersEnabled && isSmallTask) {
    return { model: fastModel, tier: "fast" as const, reason: "small_or_documentation_task" };
  }
  if (isLead || isCritical || needsWeb || needsDeepReasoning) {
    return {
      model: isLead || needsDeepReasoning || isCritical ? reasoningModel : divisionHeadModel,
      tier: isLead || needsDeepReasoning || isCritical ? ("reasoning" as const) : ("lead" as const),
      reason: isLead ? "lead_or_executive_work" : isCritical ? "critical_priority" : needsWeb ? "required_web_context" : "complex_task"
    };
  }
  return { model: workerModel, tier: "worker" as const, reason: "standard_worker_task" };
}

function isExecutiveOrDivisionHeadPrompt(providerPrompt: ProviderPromptPackage) {
  const worker = providerPrompt.context.worker;
  if (worker?.kind === "executive" || worker?.kind === "lead") {
    return true;
  }
  const name = worker?.name ?? "";
  const role = worker?.role ?? providerPrompt.instructions.role ?? "";
  return /\bexecutive\b|\bdirector\b|\bdivision head\b/i.test(`${name} ${role}`);
}

function createRequestAbortSignal(timeoutMs: number, externalSignal: AbortSignal | undefined) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!externalSignal) {
    return timeoutSignal;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeoutSignal, externalSignal]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  timeoutSignal.addEventListener("abort", abort, { once: true });
  externalSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

async function fetchWithRateLimitRetries(fetchFn: FetchLike, endpoint: string, apiKey: string, body: unknown, maxRetries: number, maxRetryWaitMs: number, requestTimeoutMs: number, externalSignal?: AbortSignal) {
  let requestCount = 0;
  let lastRateLimit: AgentRunRateLimit | undefined;
  let lastNetworkError: ReturnType<typeof sanitizeNetworkError> | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    requestCount += 1;
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: createRequestAbortSignal(requestTimeoutMs, externalSignal)
      });
    } catch (error) {
      lastNetworkError = sanitizeNetworkError(error);
      if (lastNetworkError.category === "provider_timeout") {
        lastRateLimit = {
          attempts: requestCount,
          terminalReason: "provider_timeout"
        };
        return {
          ok: false as const,
          message: `Codex provider request timed out after ${requestTimeoutMs}ms.`,
          requestCount,
          rateLimit: lastRateLimit,
          providerMetadata: {
            category: "provider_timeout",
            errorName: lastNetworkError.name,
            errorMessage: lastNetworkError.message,
            ...(lastNetworkError.causeCode ? { causeCode: lastNetworkError.causeCode } : {}),
            requestTimeoutMs
          }
        };
      }
      const waitMs = Math.min(backoffMs(attempt), maxRetryWaitMs);
      lastRateLimit = {
        retryAfterMs: waitMs,
        attempts: requestCount,
        terminalReason: attempt >= maxRetries ? "network_error" : undefined
      };

      if (attempt >= maxRetries) {
        return {
          ok: false as const,
          message: `Codex provider network request failed after ${requestCount} attempt${requestCount === 1 ? "" : "s"}: ${lastNetworkError.message}`,
          requestCount,
          rateLimit: lastRateLimit,
          providerMetadata: {
            category: "network_error",
            errorName: lastNetworkError.name,
            errorMessage: lastNetworkError.message,
            ...(lastNetworkError.causeCode ? { causeCode: lastNetworkError.causeCode } : {}),
            requestTimeoutMs
          }
        };
      }

      await delay(waitMs);
      continue;
    }

    const responseBody = await readResponseBody(response);
    if (response.status !== 429) {
      if (!response.ok) {
        const providerError = extractProviderError(responseBody);
        return {
          ok: false as const,
          message: providerError ? `Codex provider failed: ${providerError.message}` : `Codex provider failed with HTTP ${response.status}.`,
          requestCount,
          rateLimit: lastRateLimit,
          providerMetadata: {
            category: "provider_http_error",
            httpStatus: response.status,
            ...(providerError?.code ? { providerErrorCode: providerError.code } : {}),
            ...(providerError?.type ? { providerErrorType: providerError.type } : {})
          }
        };
      }
      return { ok: true as const, body: responseBody, requestCount, rateLimit: lastRateLimit };
    }

    const providerError = extractProviderError(responseBody);
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const waitMs = Math.min(retryAfterMs ?? backoffMs(attempt), maxRetryWaitMs);
    lastRateLimit = {
      quotaSource: providerError?.code === "insufficient_quota" ? "billing" : response.headers.get("x-ratelimit-limit-requests") ? "requests" : "provider",
      limit: readNumericHeader(response.headers, "x-ratelimit-limit-requests"),
      remaining: readNumericHeader(response.headers, "x-ratelimit-remaining-requests"),
      resetAt: toResetAt(response.headers.get("x-ratelimit-reset-requests")),
      retryAfterMs: waitMs,
      attempts: requestCount,
      terminalReason: providerError?.code === "insufficient_quota" ? "insufficient_quota" : attempt >= maxRetries ? "retry_exhausted" : undefined
    };

    if (providerError?.code === "insufficient_quota") {
      return {
        ok: false as const,
        message: "Codex provider quota is insufficient. Check OpenAI billing, project quota, and model access.",
        requestCount,
        rateLimit: lastRateLimit
      };
    }

    if (attempt >= maxRetries) {
      return {
        ok: false as const,
        message: providerError?.message ? `Codex provider rate limit retry budget exhausted: ${providerError.message}` : "Codex provider rate limit retry budget exhausted.",
        requestCount,
        rateLimit: lastRateLimit
      };
    }

    await delay(waitMs);
  }

  return { ok: false as const, message: "Codex provider failed.", requestCount, rateLimit: lastRateLimit };
}

function sanitizeNetworkError(error: unknown) {
  const errorRecord = error && typeof error === "object" && !Array.isArray(error) ? (error as Record<string, unknown>) : undefined;
  if (!(error instanceof Error) && !errorRecord) {
    return { name: "Error", message: "network request failed", category: "network_error" as const };
  }

  const causeValue = error instanceof Error ? error.cause : errorRecord?.cause;
  const cause = causeValue && typeof causeValue === "object" && !Array.isArray(causeValue) ? (causeValue as Record<string, unknown>) : undefined;
  const causeCode = typeof cause?.code === "string" ? cause.code.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80) : undefined;
  const name = error instanceof Error ? error.name : typeof errorRecord?.name === "string" ? errorRecord.name : "Error";
  const message = error instanceof Error ? error.message : typeof errorRecord?.message === "string" ? errorRecord.message : "network request failed";
  const isTimeout =
    name === "TimeoutError" ||
    name === "AbortError" ||
    /\b(timeout|timed out)\b/i.test(message) ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT";
  return {
    name: name.slice(0, 80) || "Error",
    message: sanitizeProviderErrorMessage(message || "network request failed"),
    causeCode,
    category: isTimeout ? ("provider_timeout" as const) : ("network_error" as const)
  };
}

function parseProviderOutputs(body: unknown) {
  const text = readOutputText(body);
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {
      artifacts: [
        {
          title: "Codex Run Notes",
          type: "provider_notes",
          content: text
        }
      ]
    };
  }
}

function readOutputText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.output_text === "string") {
    return candidate.output_text;
  }
  const output = Array.isArray(candidate.output) ? candidate.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = Array.isArray((item as Record<string, unknown>).content) ? ((item as Record<string, unknown>).content as unknown[]) : [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
        return (part as Record<string, string>).text;
      }
    }
  }
  return undefined;
}

function toUsage(body: unknown, requestCount: number, model: string, webEstimatedTokenImpact?: number): AgentRunUsage {
  const usage = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).usage : undefined;
  const record = usage && typeof usage === "object" && !Array.isArray(usage) ? (usage as Record<string, unknown>) : {};
  const details = record.input_tokens_details && typeof record.input_tokens_details === "object" && !Array.isArray(record.input_tokens_details) ? (record.input_tokens_details as Record<string, unknown>) : {};
  const inputTokens = readNumber(record.input_tokens);
  const outputTokens = readNumber(record.output_tokens);
  const cachedInputTokens = readNumber(details.cached_tokens);
  const costMicros = estimateCostMicros(model, inputTokens, outputTokens, cachedInputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    requestCount,
    costMicros,
    costSource: costMicros === undefined ? "unknown" : "estimated",
    cachedTokenRatio: inputTokens && cachedInputTokens !== undefined ? Number((cachedInputTokens / inputTokens).toFixed(4)) : undefined,
    retryOverhead: Math.max(0, requestCount - 1),
    webEstimatedTokenImpact
  };
}

function sanitizeAllowedDomains(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .flatMap((item) => (typeof item === "string" ? [item] : []))
        .map((item) => item.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase())
        .filter((item) => /^[a-z0-9.-]+$/.test(item))
        .slice(0, 20)
    )
  );
}

function extractWebSources(body: unknown) {
  const sources: Array<{ url: string; title?: string; domain?: string }> = [];
  collectWebSources(body, sources);
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) {
      return false;
    }
    seen.add(source.url);
    return true;
  }).slice(0, 20);
}

function collectWebSources(value: unknown, sources: Array<{ url: string; title?: string; domain?: string }>) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWebSources(item, sources);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? sanitizeSourceUrl(record.url) : undefined;
  if (url && (record.type === "url_citation" || record.type === "web_search_result" || "title" in record)) {
    sources.push({
      url,
      title: typeof record.title === "string" ? record.title.replace(/\s+/g, " ").trim().slice(0, 160) : undefined,
      domain: safeDomain(url)
    });
  }
  for (const item of Object.values(record)) {
    collectWebSources(item, sources);
  }
}

function sanitizeSourceUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.toString().slice(0, 500);
  } catch {
    return undefined;
  }
}

function safeDomain(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().slice(0, 120);
  } catch {
    return undefined;
  }
}

function estimateWebTokenImpact(sources: Array<{ url: string; title?: string }>) {
  if (sources.length === 0) {
    return 0;
  }
  return Math.ceil(JSON.stringify(sources).length / 4);
}

async function readResponseBody(response: Response) {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function extractProviderError(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }

  const candidate = error as Record<string, unknown>;
  return {
    type: typeof candidate.type === "string" ? candidate.type.slice(0, 80) : undefined,
    code: typeof candidate.code === "string" ? candidate.code.slice(0, 80) : undefined,
    message: typeof candidate.message === "string" ? sanitizeProviderErrorMessage(candidate.message) : "Provider request failed."
  };
}

function sanitizeProviderErrorMessage(message: string) {
  return message.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 240) || "Provider request failed.";
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

function progress(input: RunOperationInput, message: string, providerMetadata: Record<string, unknown>): RuntimeEventDraft {
  return {
    forgeId: input.forgeId,
    type: "run.progress",
    actorType: "runtime",
    targetType: "run",
    message,
    severity: "info",
    payload: { operationId: input.operationId, providerMetadata }
  };
}

function readString(body: unknown, key: string) {
  return body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>)[key] === "string" ? ((body as Record<string, string>)[key]) : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumericHeader(headers: Headers, key: string) {
  const value = Number(headers.get(key));
  return Number.isFinite(value) ? value : undefined;
}

function toResetAt(value: string | null) {
  if (!value) {
    return undefined;
  }
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return new Date(asDate).toISOString();
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number) {
  return Math.min(1000 * 2 ** attempt, 10000);
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function selectAffordableOpenAIModel(model: string) {
  if (process.env.FORGEOS_ALLOW_EXPENSIVE_MODELS === "1" || process.env.FORGEOS_ALLOW_EXPENSIVE_MODELS === "true") {
    return model;
  }

  const normalized = model.toLowerCase();
  const isKnownExpensive =
    normalized === "gpt-5.5" ||
    normalized === "gpt-5" ||
    normalized.includes("gpt-5.2-codex") ||
    (normalized.includes("gpt-5.1-codex") && !normalized.includes("mini")) ||
    (normalized.includes("gpt-4") && !normalized.includes("mini"));
  return isKnownExpensive ? AFFORDABLE_OPENAI_MODEL : model;
}

function estimateCostMicros(model: string, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0) {
  const pricing = getTokenPricing(model);
  if (!pricing || (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0)) {
    return undefined;
  }

  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const dollars =
    (uncachedInputTokens / 1_000_000) * pricing.inputPerMillion +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.round(dollars * 1_000_000);
}

function getTokenPricing(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.includes("gpt-5.2-codex")) {
    return { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 };
  }
  if (normalized.includes("gpt-5.5")) {
    return { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 };
  }
  if (normalized.includes("gpt-5.4-mini")) {
    return { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 };
  }
  if (normalized.includes("gpt-5.1-codex-mini")) {
    return { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 };
  }
  if (normalized.includes("gpt-5.1-codex") || normalized.includes("gpt-5-codex")) {
    return { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 };
  }
  return undefined;
}
