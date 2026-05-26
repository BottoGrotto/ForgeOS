import type { ExecutiveIntentInput, ExecutiveIntentProvider, ExecutiveManagerDecision, ExecutiveProposal, ExecutiveProposalDraft, ExecutiveUserQuestion } from "@/lib/runtime/types";

const MAX_EXECUTIVE_HISTORY_MESSAGES = 8;
const MAX_EXECUTIVE_HISTORY_MESSAGE_CHARS = 600;
const AFFORDABLE_EXECUTIVE_MODEL = "gpt-5.4-mini";

export interface ExecutiveProviderFailureDiagnostics {
  category: "provider_http_error" | "provider_empty_response" | "provider_invalid_json";
  message: string;
  httpStatus?: number;
  providerErrorCode?: string;
  providerErrorType?: string;
}

export class ExecutiveProviderRequestError extends Error {
  constructor(readonly diagnostics: ExecutiveProviderFailureDiagnostics) {
    super(diagnostics.message);
    this.name = "ExecutiveProviderRequestError";
  }
}

export interface LLMInput {
  forgeId: string;
  message: string;
}

export interface LLMOutput {
  content: string;
  provider: "mock" | "openclaw" | "nemoclaw";
}

export interface LLMProvider {
  sendMessage(input: LLMInput): Promise<LLMOutput>;
}

export class MockLLMProvider implements LLMProvider {
  async sendMessage(input: LLMInput): Promise<LLMOutput> {
    return {
      provider: "mock",
      content: `Executive AI acknowledged: ${input.message}`
    };
  }
}

export class MockExecutiveIntentProvider implements ExecutiveIntentProvider {
  getProviderInfo() {
    return { provider: "mock" as const };
  }

  async proposeOperationChanges(input: ExecutiveIntentInput): Promise<ExecutiveProposalDraft> {
    return {
      summary: `Executive AI reviewed: ${input.message}`,
      actions: []
    };
  }

  async decideNextExecutiveAction(input: ExecutiveIntentInput): Promise<ExecutiveManagerDecision> {
    return {
      summary: `Executive Manager reviewed: ${input.message}`,
      projectStatus: input.snapshot.operations.length > 0 ? "running" : "planning",
      userReport: `Executive Manager reviewed the project goal: ${input.message}`,
      planPatch: {
        successCriteria: ["Produce a testable project state."],
        phases: [{ title: "Plan and execute", objective: truncateText(input.message, 500) }],
        testStrategy: ["Run available verification once implementation files exist."]
      },
      operationActions: [],
      dispatchPolicy: { maxRuns: readConfiguredParallelRunTarget() ?? 1, priority: "critical_first" }
    };
  }
}

export class OpenAIExecutiveIntentProvider implements ExecutiveIntentProvider {
  constructor(
    private readonly apiKey = process.env.FORGEOS_EXECUTIVE_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.FORGEOS_CODEX_API_KEY,
    private readonly model = selectAffordableExecutiveModel(process.env.FORGEOS_EXECUTIVE_MODEL ?? process.env.OPENAI_MODEL ?? process.env.FORGEOS_CODEX_MODEL ?? AFFORDABLE_EXECUTIVE_MODEL)
  ) {}

  getProviderInfo(): { provider: ExecutiveProposal["provider"]; model?: string } {
    return { provider: "openai", model: this.model };
  }

  async proposeOperationChanges(input: ExecutiveIntentInput): Promise<ExecutiveProposalDraft> {
    if (!this.apiKey || !this.model) {
      throw new Error("Executive AI provider is not configured.");
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: "developer",
            content:
              "You convert ForgeOS operator requests into pending operation-routing proposals. Return only JSON matching the supplied schema. Use existing operation, division, and worker ids when updating, deleting, or routing approved work. If the operator modifies a pending plan, return a complete revised proposal and include the replaced pending proposal ids in supersedesProposalIds. Include operator-provided URLs and source constraints directly in affected operation descriptions or handoffs. Ask a structured operator question only when the answer materially changes product direction, personalization, constraints, audience, style, or acceptance criteria; include concise answer options and allow notes, and otherwise proceed with safe defaults. Do not ask the operator for runtime logs, launcher output, verification output, stack traces, or error codes; use recentRuntimeFindings, runtime events, verification summaries, and repair operations instead. Do not repeat an unresolved operator question that is already present in recentExecutiveQuestions. You may use delete_operation to clean duplicate, stale, blocked, failed, canceled, paused, or planning operations when the operator asks to clean up the board; ForgeOS archives operations that have run history and physically deletes only operations with no run history. Do not delete active or completed operations. Broad product, user, market, source-discovery, scope, requirements, acceptance-criteria, and authoritative-link research belongs in Strategy. Engineering may perform implementation research: technical feasibility, API/data parsing, library choice, integration constraints, performance, schema shape, and edge cases. Do not route broad project/source/user research into Engineering unless the operation is explicitly technical implementation research and its description says what technical decision it unlocks. Use Operations for coordination, handoffs, dependency routing, and staffing. Use QA for validation, correctness, usability, security, and release risk. Use Release for packaging, docs, deployment, and launch readiness. For build/start/create/make/implement/launch requests, prioritize real Engineering implementation: create at least one ready implementation or scaffold operation whose description requires concrete virtual files, source files, package scripts, or file patches. When the operator asks to research and then build, create Strategy research as the first runnable work and block implementation/scaffold/development operations on that research using dependsOnOperationKeys or dependsOnOperationIds. Create prerequisite scaffold/setup operations before app implementation when package.json, app shell, components, or data contracts do not exist, but scaffold work must still wait for requested research. QA, validation, review, release, deployment, and packaging operations may be proposed early, but they must be blocked or dependency-gated with dependsOnOperationIds/dependsOnOperationKeys until implementation operations complete with actual virtual files or file patches. Use operationKey on same-proposal create_operation actions when another new operation depends on them. Research is fine, but it must state what implementation decision it unlocks, and dependent build work must wait on it. A create_operation workerId must belong to the same divisionId; for any division-owned operation, use a worker or lead from that exact division and never a worker from another division. If unsure which worker belongs to the target division, omit workerId and let ForgeOS assign the default worker. You may create workers when the requested project needs capacity or specialization that the current team lacks, but every created worker must also receive a same-proposal ready create_operation assigned with workerName exactly matching that new worker's name. Do not create standby workers without runnable work. Do not invent repository write actions. If the operator asks to build, start, create, make, implement, or launch a new project, create at least one operation that can be assigned to an existing workerId, same-proposal workerName, or default division worker so the scheduler can run eligible work immediately; if research is requested before building, that runnable operation should be the research work. Treat the configured parallel run target as a utilization goal, not merely a ceiling: decompose work into independent, same-division, worker-owned operations that can run concurrently up to that target whenever dependencies allow. Prefer several focused ready operations for different workers over one broad serial operation, but keep true dependency gates explicit and do not parallelize work that must wait for research, implementation outputs, approval, or QA evidence. Respect any team size or parallelism the operator specifies; otherwise use the configured parallel run target supplied in context. When ongoing coordination is needed, create planning or assessment operations for division heads/directors so Executive AI can use their outputs to decide whether more workers or different teams are needed."
          },
          {
            role: "user",
            content: JSON.stringify({
              operatorMessage: input.message,
              configuredParallelRunTarget: readConfiguredParallelRunTarget(),
              delegationGuidance: buildDelegationGuidance(),
              recentExecutiveQuestions: buildRecentExecutiveQuestionHistory(input),
              recentRuntimeFindings: buildRecentRuntimeFindings(input),
              forge: input.snapshot.forge,
              recentConversation: buildRecentConversationHistory(input),
              pendingProposals: input.snapshot.proposals
                .filter((proposal) => proposal.status === "pending")
                .map(({ id, summary, actions, createdAt }) => ({ id, summary, actions, createdAt })),
              divisions: input.snapshot.divisions.map(({ id, name, objective, status }) => ({ id, name, objective, status })),
              workers: input.snapshot.workers.map(({ id, divisionId, name, role, status }) => ({ id, divisionId, name, role, status })),
              operations: input.snapshot.operations.map(({ id, divisionId, workerId, title, description, status, priority, blockedReason }) => ({
                id,
                divisionId,
                workerId,
                title,
                description,
                status,
                priority,
                blockedReason
              }))
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "executive_operation_proposal",
            strict: true,
            schema: executiveProposalJsonSchema
          }
        }
      })
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string; type?: string } };
      const detail = [body.error?.code, body.error?.type, body.error?.message].filter(Boolean).join(": ");
      throw new ExecutiveProviderRequestError({
        category: "provider_http_error",
        message: sanitizeProviderError(`Executive AI provider request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.`),
        httpStatus: response.status,
        providerErrorCode: sanitizeDiagnosticToken(body.error?.code),
        providerErrorType: sanitizeDiagnosticToken(body.error?.type)
      });
    }

    const payload = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => typeof item.text === "string")?.text;
    if (!text) {
      throw new ExecutiveProviderRequestError({
        category: "provider_empty_response",
        message: "Executive AI provider returned no structured proposal."
      });
    }

    try {
      return normalizeExecutiveProposalDraft(JSON.parse(text));
    } catch {
      throw new ExecutiveProviderRequestError({
        category: "provider_invalid_json",
        message: "Executive AI provider returned invalid structured JSON."
      });
    }
  }

  async decideNextExecutiveAction(input: ExecutiveIntentInput): Promise<ExecutiveManagerDecision> {
    const proposal = await this.proposeOperationChanges(input);
    return {
      summary: proposal.summary,
      projectStatus: input.snapshot.operations.length === 0 ? "planning" : "running",
      userReport: `Executive Manager prepared the next project plan: ${proposal.summary}`,
      planPatch: {
        successCriteria: ["Produce a testable project state.", "Report blockers and remaining verification gaps."],
        phases: [{ title: "Plan and execute", objective: truncateText(input.message, 500) }],
        testStrategy: ["Run available verification once implementation files exist."]
      },
      operationActions: proposal.actions,
      dispatchPolicy: { maxRuns: proposal.userQuestion ? 0 : readConfiguredParallelRunTarget() ?? 1, priority: "critical_first" },
      ...(proposal.userQuestion ? { userQuestion: proposal.userQuestion } : {})
    };
  }
}

function buildRecentConversationHistory(input: ExecutiveIntentInput) {
  return input.snapshot.messages
    .filter((message) => message.kind !== "executive_summary")
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-MAX_EXECUTIVE_HISTORY_MESSAGES)
    .map((message) => ({
      id: message.id,
      role: message.role,
      kind: message.kind ?? (message.role === "operator" ? "operator_prompt" : "executive_reply"),
      status: message.status,
      createdAt: message.createdAt,
      content: redactSensitiveText(truncateText(message.content, MAX_EXECUTIVE_HISTORY_MESSAGE_CHARS))
    }));
}

function buildRecentExecutiveQuestionHistory(input: ExecutiveIntentInput) {
  const answered = new Map(
    input.snapshot.events
      .filter((event) => event.type === "executive.user_input_answered")
      .flatMap((event) => {
        const questionId = readOptionalString(event.payload.questionId, 160);
        return questionId ? [[questionId, event] as const] : [];
      })
  );
  return input.snapshot.events
    .filter((event) => event.type === "executive.user_input_requested")
    .slice(-6)
    .map((event) => {
      const questionId = readOptionalString(event.payload.questionId, 160) || event.id;
      const answerEvent = answered.get(questionId);
      return {
        questionId,
        loopId: readOptionalString(event.payload.loopId, 160),
        question: redactSensitiveText(readOptionalString(event.payload.question, 500) || event.message),
        reason: redactSensitiveText(readOptionalString(event.payload.reason, 500) || "Executive AI requested operator input."),
        options: readQuestionOptions(event.payload.options),
        answered: Boolean(answerEvent),
        selectedOptionIds: readStringArray(answerEvent?.payload.selectedOptionIds, 8, 120),
        selectedLabels: readStringArray(answerEvent?.payload.selectedLabels, 8, 160),
        notes: answerEvent ? redactSensitiveText(readOptionalString(answerEvent.payload.notes, 600) || "") : undefined,
        createdAt: event.createdAt,
        answeredAt: answerEvent?.createdAt
      };
    });
}

function buildRecentRuntimeFindings(input: ExecutiveIntentInput) {
  const verificationFindings = input.snapshot.runs
    .slice()
    .reverse()
    .flatMap((run) => {
      const summary = readRuntimeVerificationSummary(run.providerMetadata.verificationSummary);
      if (!summary) {
        return [];
      }
      return [
        {
          kind: "runtime_verification",
          runId: run.id,
          operationId: run.operationId,
          status: summary.status,
          tier: summary.tier,
          checks: summary.checks,
          omittedReasons: summary.omittedReasons
        }
      ];
    })
    .slice(0, 6);

  const launcherFindings = input.snapshot.events
    .filter((event) => event.type === "launcher.check_completed" || event.type === "launcher.preview_failed" || event.type === "launcher.log")
    .slice(-8)
    .map((event) => ({
      kind: event.type,
      eventId: event.id,
      severity: event.severity,
      message: redactSensitiveText(truncateText(event.message, 240)),
      launcherId: readOptionalString(event.payload.launcherId, 160),
      status: readOptionalString(event.payload.status, 80),
      command: readOptionalString(event.payload.command, 160),
      exitCode: typeof event.payload.exitCode === "number" || event.payload.exitCode === null ? event.payload.exitCode : undefined,
      timedOut: typeof event.payload.timedOut === "boolean" ? event.payload.timedOut : undefined,
      reason: redactSensitiveText(readOptionalString(event.payload.reason, 500) || ""),
      outputTail: redactSensitiveText(truncateText(readOptionalString(event.payload.output, 1200) || "", 1200)),
      createdAt: event.createdAt
    }));

  return [...verificationFindings, ...launcherFindings].filter((item) => Object.values(item).some((value) => value !== undefined && value !== ""));
}

function readRuntimeVerificationSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const status = readOptionalString(candidate.status, 40);
  if (!status) {
    return undefined;
  }
  return {
    status,
    tier: readOptionalString(candidate.tier, 40),
    checks: Array.isArray(candidate.checks)
      ? candidate.checks.flatMap((check) => {
          if (!check || typeof check !== "object" || Array.isArray(check)) {
            return [];
          }
          const item = check as Record<string, unknown>;
          const name = readOptionalString(item.name, 160);
          const checkStatus = readOptionalString(item.status, 40);
          if (!name || !checkStatus) {
            return [];
          }
          return [
            {
              name,
              status: checkStatus,
              message: redactSensitiveText(readOptionalString(item.message, 500) || ""),
              exitCode: typeof item.exitCode === "number" || item.exitCode === null ? item.exitCode : undefined,
              timedOut: typeof item.timedOut === "boolean" ? item.timedOut : undefined,
              outputTail: redactSensitiveText(readOptionalString(item.outputTail, 1200) || "")
            }
          ];
        }).slice(0, 8)
      : [],
    omittedReasons: readStringArray(candidate.omittedReasons, 8, 240)
  };
}

function readQuestionOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return [];
      }
      const candidate = option as Record<string, unknown>;
      const id = readOptionalString(candidate.id, 120);
      const label = readOptionalString(candidate.label, 160);
      const description = readOptionalString(candidate.description, 300);
      return id && label ? [{ id, label, ...(description ? { description } : {}) }] : [];
    })
    .slice(0, 6);
}

function buildDelegationGuidance() {
  return [
    {
      division: "strategy",
      owns: ["product/user/source-discovery research", "requirements and scope", "authoritative source selection", "success criteria and acceptance criteria"],
      avoid: ["implementation-only parsing details", "library-specific engineering decisions"]
    },
    {
      division: "engineering",
      owns: ["technical feasibility research", "API/data parsing approach", "library and integration choices", "schema/performance/edge-case implementation decisions"],
      avoid: ["broad product research", "user-needs discovery", "project scope decisions without Strategy handoff"]
    },
    {
      division: "operations",
      owns: ["team coordination", "handoffs", "dependency routing", "staffing and run-slot organization"],
      avoid: ["owning implementation deliverables", "workers from another division for Operations-owned work"]
    },
    {
      division: "qa",
      owns: ["correctness validation", "usability review", "security and data-quality risk", "release-blocking defect reports"],
      avoid: ["primary feature implementation", "workers from another division for QA-owned work"]
    },
    {
      division: "release",
      owns: ["final packaging", "documentation", "deployment readiness", "launch checklist"],
      avoid: ["unapproved scope changes", "workers from another division for Release-owned work"]
    }
  ];
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]`;
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-secret]")
    .replace(/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g, "[redacted-secret]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{12,}@/g, "[redacted-secret]@");
}

function selectAffordableExecutiveModel(model: string) {
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
  return isKnownExpensive ? AFFORDABLE_EXECUTIVE_MODEL : model;
}

const executiveProposalJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "supersedesProposalIds", "userQuestion", "actions"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 500 },
    supersedesProposalIds: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 160 }
    },
    userQuestion: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["reason", "question", "options", "allowNotes"],
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 500 },
            question: { type: "string", minLength: 1, maxLength: 500 },
            options: {
              type: "array",
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label", "description"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 120 },
                  label: { type: "string", minLength: 1, maxLength: 160 },
                  description: { type: ["string", "null"], minLength: 1, maxLength: 300 }
                }
              }
            },
            allowNotes: { type: "boolean" }
          }
        },
        { type: "null" }
      ]
    },
    actions: {
      type: "array",
      maxItems: 8,
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "name", "role", "divisionId", "currentTask", "status"],
            properties: {
              type: { type: "string", enum: ["create_worker"] },
              name: { type: "string", minLength: 1, maxLength: 120 },
              role: { type: "string", minLength: 1, maxLength: 160 },
              divisionId: { type: "string", minLength: 1, maxLength: 120 },
              currentTask: { type: ["string", "null"], minLength: 1, maxLength: 240 },
              status: { type: ["string", "null"], enum: ["idle", "planning", "ready", null] }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "operationKey", "title", "description", "divisionId", "workerId", "workerName", "priority", "status", "dependsOnOperationIds", "dependsOnOperationKeys"],
            properties: {
              type: { type: "string", enum: ["create_operation"] },
              operationKey: { type: ["string", "null"], minLength: 1, maxLength: 120 },
              title: { type: "string", minLength: 1, maxLength: 160 },
              description: { type: "string", minLength: 1, maxLength: 1000 },
              divisionId: { type: "string", minLength: 1, maxLength: 120 },
              workerId: { type: ["string", "null"], minLength: 1, maxLength: 120 },
              workerName: { type: ["string", "null"], minLength: 1, maxLength: 120 },
              priority: { type: ["string", "null"], enum: ["low", "normal", "high", "critical", null] },
              status: { type: ["string", "null"], enum: ["planning", "ready", "blocked", null] },
              dependsOnOperationIds: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 240 } },
              dependsOnOperationKeys: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 120 } }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "operationId", "title", "description", "divisionId", "workerId", "priority", "status", "blockedReason"],
            properties: {
              type: { type: "string", enum: ["update_operation"] },
              operationId: { type: "string", minLength: 1, maxLength: 240 },
              title: { type: ["string", "null"], minLength: 1, maxLength: 160 },
              description: { type: ["string", "null"], minLength: 1, maxLength: 1000 },
              divisionId: { type: ["string", "null"], minLength: 1, maxLength: 120 },
              workerId: { type: ["string", "null"], minLength: 1, maxLength: 120 },
              priority: { type: ["string", "null"], enum: ["low", "normal", "high", "critical", null] },
              status: { type: ["string", "null"], enum: ["planning", "ready", "blocked", null] },
              blockedReason: { type: ["string", "null"], minLength: 1, maxLength: 500 }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "operationId", "reason"],
            properties: {
              type: { type: "string", enum: ["delete_operation"] },
              operationId: { type: "string", minLength: 1, maxLength: 240 },
              reason: { type: "string", minLength: 1, maxLength: 500 }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "fromDivisionId", "toDivisionId", "targetOperationId", "summary", "deliverables", "blockers", "requiredContext", "confidence"],
            properties: {
              type: { type: "string", enum: ["create_handoff"] },
              fromDivisionId: { type: "string", minLength: 1, maxLength: 120 },
              toDivisionId: { type: "string", minLength: 1, maxLength: 120 },
              targetOperationId: { type: ["string", "null"], minLength: 1, maxLength: 240 },
              summary: { type: "string", minLength: 1, maxLength: 500 },
              deliverables: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 160 } },
              blockers: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 160 } },
              requiredContext: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 160 } },
              confidence: { type: "integer", minimum: 0, maximum: 100 }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "operationId", "reason", "severity"],
            properties: {
              type: { type: "string", enum: ["create_blocker"] },
              operationId: { type: "string", minLength: 1, maxLength: 240 },
              reason: { type: "string", minLength: 1, maxLength: 500 },
              severity: { type: ["string", "null"], enum: ["info", "success", "warning", "error", null] }
            }
          }
        ]
      }
    }
  }
};

function normalizeExecutiveProposalDraft(value: unknown): ExecutiveProposalDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { summary: "", actions: [] };
  }

  const candidate = value as { summary?: unknown; supersedesProposalIds?: unknown; actions?: unknown; userQuestion?: unknown };
  return {
    summary: readRequiredString(candidate.summary, 500),
    actions: Array.isArray(candidate.actions) ? candidate.actions.flatMap(normalizeExecutiveProposalAction) : [],
    supersedesProposalIds: Array.isArray(candidate.supersedesProposalIds)
      ? candidate.supersedesProposalIds.flatMap((id) => {
          const bounded = readOptionalString(id, 160);
          return bounded ? [bounded] : [];
        }).slice(0, 8)
      : [],
    ...(normalizeExecutiveUserQuestion(candidate.userQuestion) ? { userQuestion: normalizeExecutiveUserQuestion(candidate.userQuestion) } : {})
  };
}

function normalizeExecutiveUserQuestion(value: unknown): ExecutiveUserQuestion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const reason = readRequiredString(candidate.reason, 500);
  const question = readRequiredString(candidate.question, 500);
  if (!reason || !question) {
    return undefined;
  }
  const options = Array.isArray(candidate.options)
    ? candidate.options
        .flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return [];
          }
          const rawOption = option as Record<string, unknown>;
          const id = readRequiredString(rawOption.id, 120);
          const label = readRequiredString(rawOption.label, 160);
          const description = readOptionalString(rawOption.description, 300);
          return id && label ? [{ id, label, ...(description ? { description } : {}) }] : [];
        })
        .slice(0, 6)
    : [];
  const normalized = {
    reason,
    question,
    options,
    allowNotes: candidate.allowNotes !== false
  };
  return isRuntimeDiagnosticQuestionText(`${question} ${reason} ${options.map((option) => `${option.label} ${option.description ?? ""}`).join(" ")}`) ? undefined : normalized;
}

function isRuntimeDiagnosticQuestionText(value: string) {
  const normalized = value.toLowerCase();
  const askSignal = /\b(provide|send|share|paste|give|need|show|upload|attach)\b/.test(normalized);
  const diagnosticSignal = /\b(log|logs|tail|stderr|stdout|stack trace|trace|error code|exit code|verification output|launcher output|runtime check|build output|test output|console output)\b/.test(normalized);
  return askSignal && diagnosticSignal;
}

function normalizeExecutiveProposalAction(value: unknown): ExecutiveProposalDraft["actions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const action = value as Record<string, unknown>;
  if (action.type === "create_worker") {
    return [{
      type: "create_worker",
      name: readRequiredString(action.name, 120),
      role: readRequiredString(action.role, 160),
      divisionId: readRequiredString(action.divisionId, 120),
      ...(readOptionalString(action.currentTask, 240) ? { currentTask: readOptionalString(action.currentTask, 240) } : {}),
      ...(isWorkerStatus(action.status) ? { status: action.status } : {})
    }];
  }
  if (action.type === "create_operation") {
    return [{
      type: "create_operation",
      ...(readOptionalString(action.operationKey, 120) ? { operationKey: readOptionalString(action.operationKey, 120) } : {}),
      title: readRequiredString(action.title, 160),
      description: readRequiredString(action.description, 1000),
      divisionId: readRequiredString(action.divisionId, 120),
      ...(readOptionalString(action.workerId, 120) ? { workerId: readOptionalString(action.workerId, 120) } : {}),
      ...(readOptionalString(action.workerName, 120) ? { workerName: readOptionalString(action.workerName, 120) } : {}),
      ...(isOperationPriority(action.priority) ? { priority: action.priority } : {}),
      ...(isOperationStatus(action.status) ? { status: action.status } : {}),
      dependsOnOperationIds: readStringArray(action.dependsOnOperationIds, 8, 240),
      dependsOnOperationKeys: readStringArray(action.dependsOnOperationKeys, 8, 120)
    }];
  }
  if (action.type === "update_operation") {
    return [{
      type: "update_operation",
      operationId: readRequiredString(action.operationId, 240),
      ...(readOptionalString(action.title, 160) ? { title: readOptionalString(action.title, 160) } : {}),
      ...(readOptionalString(action.description, 1000) ? { description: readOptionalString(action.description, 1000) } : {}),
      ...(readOptionalString(action.divisionId, 120) ? { divisionId: readOptionalString(action.divisionId, 120) } : {}),
      ...(readOptionalString(action.workerId, 120) ? { workerId: readOptionalString(action.workerId, 120) } : {}),
      ...(isOperationPriority(action.priority) ? { priority: action.priority } : {}),
      ...(isOperationStatus(action.status) ? { status: action.status } : {}),
      ...(readOptionalString(action.blockedReason, 500) ? { blockedReason: readOptionalString(action.blockedReason, 500) } : {})
    }];
  }
  if (action.type === "delete_operation") {
    return [{
      type: "delete_operation",
      operationId: readRequiredString(action.operationId, 240),
      reason: readRequiredString(action.reason, 500)
    }];
  }
  if (action.type === "create_handoff") {
    return [{
      type: "create_handoff",
      fromDivisionId: readRequiredString(action.fromDivisionId, 120),
      toDivisionId: readRequiredString(action.toDivisionId, 120),
      ...(readOptionalString(action.targetOperationId, 240) ? { targetOperationId: readOptionalString(action.targetOperationId, 240) } : {}),
      summary: readRequiredString(action.summary, 500),
      deliverables: readStringArray(action.deliverables, 8, 160),
      blockers: readStringArray(action.blockers, 8, 160),
      requiredContext: readStringArray(action.requiredContext, 8, 160),
      ...(typeof action.confidence === "number" && Number.isFinite(action.confidence) ? { confidence: Math.max(0, Math.min(100, Math.round(action.confidence))) } : {})
    }];
  }
  if (action.type === "create_blocker") {
    return [{
      type: "create_blocker",
      operationId: readRequiredString(action.operationId, 240),
      reason: readRequiredString(action.reason, 500),
      ...(isSeverity(action.severity) ? { severity: action.severity } : {})
    }];
  }

  return [];
}

function readRequiredString(value: unknown, maxChars: number) {
  return typeof value === "string" ? truncateText(value.trim(), maxChars) : "";
}

function readOptionalString(value: unknown, maxChars: number) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? truncateText(trimmed, maxChars) : undefined;
}

function readStringArray(value: unknown, maxItems: number, maxChars: number) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const bounded = readOptionalString(item, maxChars);
        return bounded ? [bounded] : [];
      }).slice(0, maxItems)
    : [];
}

function isWorkerStatus(value: unknown): value is "idle" | "planning" | "ready" {
  return value === "idle" || value === "planning" || value === "ready";
}

function isOperationPriority(value: unknown): value is "low" | "normal" | "high" | "critical" {
  return value === "low" || value === "normal" || value === "high" || value === "critical";
}

function isOperationStatus(value: unknown): value is "planning" | "ready" | "blocked" {
  return value === "planning" || value === "ready" || value === "blocked";
}

function isSeverity(value: unknown): value is "info" | "success" | "warning" | "error" {
  return value === "info" || value === "success" || value === "warning" || value === "error";
}

function readConfiguredParallelRunTarget() {
  const raw = process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS ?? process.env.FORGEOS_CODEX_MAX_CONCURRENT_RUNS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sanitizeProviderError(message: string) {
  return message.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function sanitizeDiagnosticToken(value: string | undefined) {
  return value ? value.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80) : undefined;
}
