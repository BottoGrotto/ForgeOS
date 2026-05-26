import type { ForgeSnapshot } from "@/lib/runtime/types";

const now = new Date("2026-05-17T20:00:00.000Z").toISOString();

export interface CreateForgeSnapshotInput {
  id: string;
  slug: string;
  name: string;
  tagline?: string;
  prefixEntityIds?: boolean;
}

export function createDemoSnapshot(): ForgeSnapshot {
  return createForgeSnapshot({
    id: "demo-forge",
    slug: "demo",
    name: "ForgeOS Demo Forge",
    tagline: "An operating system for autonomous AI organizations."
  });
}

export function createEmptyForgeSnapshot(input: CreateForgeSnapshotInput): ForgeSnapshot {
  const timestamp = new Date().toISOString();
  const organization = createForgeSnapshot(input);
  const divisions = organization.divisions.map((division) => ({
    ...division,
    status: "idle" as const,
    progress: 0
  }));
  const workers = organization.workers.map((item) => ({
    ...item,
    status: "idle" as const,
    currentTask: "Waiting for operation assignment",
    contextManifest: defaultWorkerContextManifest(item.id, item.name, item.role, "Waiting for operation assignment", {
      virtualFileRefs: [],
      artifactRefs: [],
      recentEventSummary: ["Fresh Forge initialized."]
    })
  }));

  return {
    forge: {
      id: input.id,
      slug: input.slug,
      name: input.name,
      tagline: input.tagline ?? "Fresh Forge workspace.",
      activePhase: "Planning",
      status: "active"
    },
    lastEventSequence: 1,
    schemaVersion: 5,
    divisions,
    workers,
    operations: [],
    runs: [],
    dependencies: [],
    artifacts: [],
    files: [],
    handoffs: [],
    messages: [],
    proposals: [],
    executiveLoops: [],
    executiveCycles: [],
    executivePlans: [],
    executiveReports: [],
    events: [
      {
        id: `${input.slug}-event-1`,
        forgeId: input.id,
        sequence: 1,
        type: "forge.initialized",
        actorType: "runtime",
        targetType: "forge",
        targetId: input.id,
        message: "Empty Forge workspace initialized.",
        severity: "success",
        payload: { template: "empty" },
        createdAt: timestamp
      }
    ]
  };
}

export function createForgeSnapshot(input: CreateForgeSnapshotInput): ForgeSnapshot {
  const tagline = input.tagline ?? "An operating system for autonomous AI organizations.";
  const idFor = input.prefixEntityIds ? (id: string) => `${input.slug}-${id}` : (id: string) => id;

  const divisions = [
    { id: idFor("strategy"), name: "Strategy Division", objective: "Shape the project direction and hackathon strategy.", status: "completed", progress: 100, order: 1, leadWorkerId: idFor("strategy-director") },
    { id: idFor("operations"), name: "Operations Division", objective: "Coordinate handoffs, blockers, and organizational alignment.", status: "running", progress: 72, order: 2, leadWorkerId: idFor("ops-coordinator") },
    { id: idFor("engineering"), name: "Engineering Division", objective: "Build the product through dependency-aware operations.", status: "running", progress: 61, order: 3, leadWorkerId: idFor("eng-director") },
    { id: idFor("presentation"), name: "Presentation Division", objective: "Create pitch narrative, demo flow, and judge positioning.", status: "reviewing", progress: 54, order: 4, leadWorkerId: idFor("story-strategist") },
    { id: idFor("qa"), name: "QA Division", objective: "Review implementation, pitch, and organizational consistency.", status: "planning", progress: 22, order: 5, leadWorkerId: idFor("qa-runner-alpha") },
    { id: idFor("release"), name: "Release Division", objective: "Finalize launch readiness, documentation, and demo path.", status: "idle", progress: 8, order: 6, leadWorkerId: idFor("release-director") }
  ] as ForgeSnapshot["divisions"];

  const workers = [
    worker(idFor("executive-ai"), idFor("operations"), "Executive AI", "Runtime coordinator", "running", "Coordinating Forge status", "executive"),
    worker(idFor("strategy-director"), idFor("strategy"), "Strategy Director", "Project strategy owner", "completed", "Finalized Forge plan", "lead", idFor("executive-ai")),
    worker(idFor("research-analyst"), idFor("strategy"), "Research Analyst", "Competitive and sponsor research", "completed", "Delivered market scan", "worker", idFor("strategy-director")),
    worker(idFor("ops-coordinator"), idFor("operations"), "Engineering Coordinator", "Cross-division operations router", "running", "Routing engineering handoff", "lead", idFor("executive-ai")),
    worker(idFor("eng-director"), idFor("engineering"), "Engineering Director", "Technical execution owner", "running", "Sequencing implementation graph", "lead", idFor("executive-ai")),
    worker(idFor("frontend-worker"), idFor("engineering"), "Frontend Worker", "Command center UI specialist", "running", "Building dashboard shell", "worker", idFor("eng-director")),
    worker(idFor("backend-worker"), idFor("engineering"), "Backend Worker", "Runtime and API specialist", "ready", "Waiting for schema lock", "worker", idFor("eng-director")),
    worker(idFor("testing-worker"), idFor("engineering"), "Testing Worker", "Verification specialist", "blocked", "Waiting for UI contracts", "worker", idFor("eng-director")),
    worker(idFor("story-strategist"), idFor("presentation"), "Story Strategist", "Pitch narrative owner", "reviewing", "Reviewing judge story", "lead", idFor("executive-ai")),
    worker(idFor("qa-runner-alpha"), idFor("qa"), "QA Runner Alpha", "Autonomous review runner", "planning", "Preparing validation plan", "lead", idFor("executive-ai")),
    worker(idFor("release-director"), idFor("release"), "Release Director", "Submission readiness owner", "idle", "Waiting for QA pass", "lead", idFor("executive-ai"))
  ] as ForgeSnapshot["workers"];

  const operations = [
    op(idFor("op-strategy-plan"), idFor("strategy"), idFor("strategy-director"), "Finalize Forge strategy", "Define scope, judge angle, risks, and execution roadmap.", "completed", 100, []),
    op(idFor("op-research"), idFor("strategy"), idFor("research-analyst"), "Research sponsor alignment", "Identify competitive framing and sponsor-friendly capabilities.", "completed", 100, []),
    op(idFor("op-handoff-eng"), idFor("operations"), idFor("ops-coordinator"), "Prepare engineering handoff", "Convert strategy into build-ready operations and constraints.", "completed", 100, [idFor("artifact-strategy")]),
    op(idFor("op-runtime"), idFor("engineering"), idFor("backend-worker"), "Implement runtime contracts", "Create RuntimeStore, event stream, scheduler, and mock adapter.", "ready", 25, []),
    op(idFor("op-dashboard"), idFor("engineering"), idFor("frontend-worker"), "Build Forge Command Center", "Render cockpit, org map, operations board, inspector, and console.", "running", 58, []),
    op(idFor("op-tests"), idFor("engineering"), idFor("testing-worker"), "Verify runtime and UI", "Cover event ordering, dependency readiness, APIs, and golden flow.", "blocked", 10, [], "Waiting for runtime contracts"),
    op(idFor("op-pitch"), idFor("presentation"), idFor("story-strategist"), "Draft demo narrative", "Create pitch outline and demo script aligned to ForgeOS value.", "reviewing", 61, [idFor("artifact-pitch")]),
    op(idFor("op-qa"), idFor("qa"), idFor("qa-runner-alpha"), "Run organizational review", "Inspect output quality, security risks, and release readiness.", "planning", 15, []),
    op(idFor("op-release"), idFor("release"), idFor("release-director"), "Prepare release pass", "Finalize README, checklist, and submission readiness.", "planning", 5, [])
  ] as ForgeSnapshot["operations"];

  const dependencies = [
    dep(idFor("dep-runtime-handoff"), idFor("op-runtime"), idFor("op-handoff-eng")),
    dep(idFor("dep-dashboard-runtime"), idFor("op-dashboard"), idFor("op-runtime"), "informs"),
    dep(idFor("dep-tests-runtime"), idFor("op-tests"), idFor("op-runtime")),
    dep(idFor("dep-qa-dashboard"), idFor("op-qa"), idFor("op-dashboard")),
    dep(idFor("dep-qa-pitch"), idFor("op-qa"), idFor("op-pitch")),
    dep(idFor("dep-release-qa"), idFor("op-release"), idFor("op-qa"))
  ] as ForgeSnapshot["dependencies"];

  const artifacts = [
    artifact(idFor("artifact-strategy"), "ForgeOS Project Plan", "project_plan", idFor("strategy"), idFor("strategy-director"), idFor("op-strategy-plan"), "A serious AI organization runtime for hackathon execution with visible hierarchy, artifacts, handoffs, and release pass.", "finalized", ["strategy", "scope"]),
    artifact(idFor("artifact-architecture"), "Runtime Architecture Proposal", "architecture_plan", idFor("engineering"), idFor("eng-director"), idFor("op-runtime"), "Server-authoritative snapshot plus append-only events, strict runtime adapters, and virtual workspace boundaries.", "generated", ["runtime", "events"]),
    artifact(idFor("artifact-pitch"), "Presentation Outline", "pitch_outline", idFor("presentation"), idFor("story-strategist"), idFor("op-pitch"), "Position ForgeOS as Kubernetes for autonomous AI organizations, focused on command visibility and execution confidence.", "generated", ["pitch", "judges"]),
    artifact(idFor("artifact-qa"), "QA Risk Register", "review_report", idFor("qa"), idFor("qa-runner-alpha"), idFor("op-qa"), "Open risks: endpoint hardening, event ordering, XSS in rendered generated content, and real-agent adapter contract drift.", "draft", ["qa", "security"])
  ] as ForgeSnapshot["artifacts"];

  const files = [
    file(idFor("file-readme"), "README.md", "# ForgeOS\n\nAn operating system for autonomous AI organizations.\n", "generated", idFor("strategy"), idFor("strategy-director"), idFor("op-strategy-plan"), [idFor("artifact-strategy")]),
    file(idFor("file-page"), "src/app/page.tsx", "export default function Page() {\n  return <ForgeCommandCenter />\n}\n", "draft", idFor("engineering"), idFor("frontend-worker"), idFor("op-dashboard"), [idFor("artifact-architecture")]),
    file(idFor("file-plan"), "docs/project-plan.md", "# Project Plan\n\nForgeOS command center, runtime, and release pipeline.\n", "finalized", idFor("strategy"), idFor("strategy-director"), idFor("op-strategy-plan"), [idFor("artifact-strategy")]),
    file(idFor("file-pitch"), "pitch/presentation-outline.md", "# Pitch Outline\n\nProblem, autonomous organization runtime, demo flow, and release pass.\n", "generated", idFor("presentation"), idFor("story-strategist"), idFor("op-pitch"), [idFor("artifact-pitch")]),
    file(idFor("file-qa"), "review/qa-report.md", "# QA Report\n\nRuntime state and command APIs require focused validation.\n", "draft", idFor("qa"), idFor("qa-runner-alpha"), idFor("op-qa"), [idFor("artifact-qa")])
  ];

  const handoffs = [
    {
      id: idFor("handoff-strategy-ops"),
      fromDivisionId: idFor("strategy"),
      toDivisionId: idFor("operations"),
      summary: "Strategy has locked the product identity, core scope, and MVP operating model.",
      deliverables: ["Project plan", "Competitive positioning", "Scope constraints"],
      blockers: [],
      requiredContext: ["Build dashboard first", "Keep mock-to-real adapters strict"],
      artifactIds: [idFor("artifact-strategy")],
      fileIds: [idFor("file-plan")],
      status: "open" as const,
      confidence: 92,
      createdAt: now
    },
    {
      id: idFor("handoff-ops-eng"),
      fromDivisionId: idFor("operations"),
      toDivisionId: idFor("engineering"),
      summary: "Engineering can proceed with runtime contracts and command center shell.",
      deliverables: ["Operation graph", "Runtime boundaries", "UI panel priorities"],
      blockers: ["Testing waits for runtime event contract"],
      requiredContext: ["Virtual files only", "No raw provider internals"],
      artifactIds: [idFor("artifact-runtime")],
      fileIds: [idFor("file-runtime")],
      status: "open" as const,
      confidence: 84,
      createdAt: now
    }
  ];

  const messages = [
    { id: idFor("msg-1"), role: "executive", kind: "executive_reply", source: "manual", content: "Forge initialized. Strategy is complete, engineering is active, and QA is preparing the release review.", createdAt: now },
    { id: idFor("msg-2"), role: "operator", kind: "operator_prompt", source: "manual", content: "Surface the current blockers.", createdAt: now },
    { id: idFor("msg-3"), role: "executive", kind: "executive_reply", source: "manual", content: "Primary blocker: testing worker is waiting for runtime contracts. Recommendation: lock RuntimeEvent and ForgeSnapshot before broad UI expansion.", createdAt: now }
  ] as ForgeSnapshot["messages"];

  const events = [
    event(input.id, idFor, 1, "forge.initialized", "runtime", "forge", input.id, "Forge initialized with seeded autonomous organization.", "success"),
    event(input.id, idFor, 2, "operation.completed", "worker", "operation", idFor("op-strategy-plan"), "Strategy plan finalized.", "success"),
    event(input.id, idFor, 3, "handoff.created", "division", "handoff", idFor("handoff-strategy-ops"), "Strategy handed execution context to Operations.", "info"),
    event(input.id, idFor, 4, "operation.started", "worker", "operation", idFor("op-dashboard"), "Frontend Worker started the command center.", "info"),
    event(input.id, idFor, 5, "operation.blocked", "worker", "operation", idFor("op-tests"), "Testing is blocked on runtime contract completion.", "warning")
  ];

  return {
    forge: {
      id: input.id,
      slug: input.slug,
      name: input.name,
      tagline,
      activePhase: "Autonomous Development",
      status: "active"
    },
    lastEventSequence: events.length,
    schemaVersion: 2,
    divisions,
    workers,
    operations,
    runs: [],
    dependencies,
    artifacts,
    files,
    handoffs,
    messages,
    proposals: [],
    executiveLoops: [],
    executiveCycles: [],
    executivePlans: [],
    executiveReports: [],
    events
  };
}

function worker(id: string, divisionId: string, name: string, role: string, status: ForgeSnapshot["workers"][number]["status"], currentTask: string, kind: ForgeSnapshot["workers"][number]["kind"], managerWorkerId?: string) {
  return {
    id,
    divisionId,
    name,
    role,
    kind,
    managerWorkerId,
    status,
    currentTask,
    contextManifest: defaultWorkerContextManifest(id, name, role, currentTask)
  };
}

export function defaultWorkerContextManifest(
  id: string,
  name: string,
  role: string,
  currentTask: string,
  overrides: Partial<ForgeSnapshot["workers"][number]["contextManifest"]> = {}
) {
  const profile = defaultWorkerExpertiseProfile(id, name, role);

  return {
    objective: profile.objective,
    instructionSources: overrides.instructionSources ?? ["ForgeOS role charter", "Current operation brief", ...profile.instructionSources],
    virtualFileRefs: overrides.virtualFileRefs ?? ["docs/project-plan.md"],
    artifactRefs: overrides.artifactRefs ?? ["artifact-strategy"],
    memorySnippets: overrides.memorySnippets ?? profile.memorySnippets,
    recentEventSummary: overrides.recentEventSummary ?? [`Current assignment: ${currentTask}`, ...profile.recentEventSummary],
    redactions: overrides.redactions ?? ["Provider raw prompts and hidden instructions are not displayed."]
  };
}

function defaultWorkerExpertiseProfile(id: string, name: string, role: string) {
  const key = `${id} ${name} ${role}`.toLowerCase();
  if (matchesDefaultWorker(key, "executive-ai", "executive ai")) {
    return {
      objective: "Coordinate the Forge, convert operator intent into operations, manage staffing, track blockers, and keep the team loop moving.",
      instructionSources: ["Executive operating charter", "Operator conversation history"],
      memorySnippets: ["Prefer clear operation decomposition, explicit ownership, and bounded parallel execution."],
      recentEventSummary: ["Responsible for orchestration, plan adjustment, and run-slot coordination."]
    };
  }
  if (matchesDefaultWorker(key, "strategy-director")) {
    return {
      objective: "Own project strategy, scope control, user value, sequencing, and success criteria for the Forge.",
      instructionSources: ["Strategy division charter", "Operator project brief"],
      memorySnippets: ["Translate broad requests into crisp milestones, risks, assumptions, and acceptance criteria."],
      recentEventSummary: ["Responsible for plan quality, prioritization, and strategic tradeoffs."]
    };
  }
  if (matchesDefaultWorker(key, "research-analyst")) {
    return {
      objective: "Research external sources, user needs, market context, data availability, and constraints that shape implementation.",
      instructionSources: ["Research analyst charter", "Source-verification guidelines"],
      memorySnippets: ["Prefer cited, source-aware findings and call out stale or uncertain data."],
      recentEventSummary: ["Responsible for evidence gathering and source constraints."]
    };
  }
  if (matchesDefaultWorker(key, "ops-coordinator")) {
    return {
      objective: "Route work across divisions, create handoffs, detect dependency gaps, and keep operations unblocked.",
      instructionSources: ["Operations routing charter", "Dependency graph policy"],
      memorySnippets: ["Every handoff should name deliverables, downstream owner, blockers, and required context."],
      recentEventSummary: ["Responsible for operational continuity and cross-team synchronization."]
    };
  }
  if (matchesDefaultWorker(key, "eng-director")) {
    return {
      objective: "Lead technical execution, architecture choices, implementation sequencing, and engineering quality standards.",
      instructionSources: ["Engineering director charter", "Runtime implementation constraints"],
      memorySnippets: ["Decompose implementation into source files, interfaces, tests, and integration checkpoints."],
      recentEventSummary: ["Responsible for technical direction and implementation readiness."]
    };
  }
  if (matchesDefaultWorker(key, "frontend-worker")) {
    return {
      objective: "Build mobile-first, accessible, responsive UI with clear information architecture and polished interaction states.",
      instructionSources: ["Frontend worker charter", "ForgeOS frontend design rules"],
      memorySnippets: ["Produce concrete UI files, component structure, responsive states, and user-flow details."],
      recentEventSummary: ["Responsible for interface implementation and user-facing polish."]
    };
  }
  if (matchesDefaultWorker(key, "backend-worker")) {
    return {
      objective: "Build APIs, data flows, runtime contracts, provider integrations, persistence, and server-side validation.",
      instructionSources: ["Backend worker charter", "Runtime API contract"],
      memorySnippets: ["Prefer typed contracts, schema validation, sanitized provider boundaries, and durable persistence behavior."],
      recentEventSummary: ["Responsible for backend implementation and data/runtime correctness."]
    };
  }
  if (matchesDefaultWorker(key, "testing-worker")) {
    return {
      objective: "Design and execute verification for unit, integration, E2E, accessibility, regression, and runtime behavior.",
      instructionSources: ["Testing worker charter", "Verification policy"],
      memorySnippets: ["Turn requirements into test cases and include failure modes, fixtures, and acceptance checks."],
      recentEventSummary: ["Responsible for validation coverage and release confidence."]
    };
  }
  if (matchesDefaultWorker(key, "story-strategist")) {
    return {
      objective: "Craft demo narrative, product positioning, user story, pitch structure, and stakeholder-facing explanations.",
      instructionSources: ["Presentation division charter", "Demo narrative brief"],
      memorySnippets: ["Keep messaging concrete, outcome-oriented, and grounded in what the Forge actually built."],
      recentEventSummary: ["Responsible for narrative clarity and demo communication."]
    };
  }
  if (matchesDefaultWorker(key, "qa-runner")) {
    return {
      objective: "Review output quality, correctness, usability, data accuracy, security risks, and release readiness.",
      instructionSources: ["QA runner charter", "Release quality checklist"],
      memorySnippets: ["Report concrete defects, severity, reproduction notes, and release-blocking risks."],
      recentEventSummary: ["Responsible for independent quality review."]
    };
  }
  if (matchesDefaultWorker(key, "release-director")) {
    return {
      objective: "Prepare final release pass, documentation, deployment checklist, handoff notes, and launch readiness.",
      instructionSources: ["Release director charter", "Submission readiness checklist"],
      memorySnippets: ["Verify the demo path, artifacts, docs, known risks, and operator-visible release status."],
      recentEventSummary: ["Responsible for final packaging and release confidence."]
    };
  }

  return {
    objective: `Specialize in ${role}.`,
    instructionSources: ["ForgeOS role charter"],
    memorySnippets: [`Apply ${role} expertise to the assigned operation.`],
    recentEventSummary: ["Ready to receive a specialized operation assignment."]
  };
}

export function isDefaultForgeWorker(id: string, name: string, role: string) {
  const idKey = id.toLowerCase();
  const nameKey = name.toLowerCase();
  const roleKey = role.toLowerCase();
  const defaultIds = [
    "executive-ai",
    "strategy-director",
    "research-analyst",
    "ops-coordinator",
    "eng-director",
    "frontend-worker",
    "backend-worker",
    "testing-worker",
    "story-strategist",
    "qa-runner",
    "release-director"
  ];

  return (
    defaultIds.some((marker) => idKey === marker || idKey.endsWith(`-${marker}`)) ||
    (nameKey === "executive ai" && roleKey === "runtime coordinator") ||
    (nameKey === "frontend worker" && roleKey === "command center ui specialist") ||
    (nameKey === "backend worker" && roleKey === "runtime and api specialist") ||
    (nameKey === "testing worker" && roleKey === "verification specialist")
  );
}

function matchesDefaultWorker(key: string, ...markers: string[]) {
  return markers.some((marker) => new RegExp(`(?:^|-)${marker}(?:$|\\s|-)`).test(key) || key.includes(marker.replace(/-/g, " ")));
}

function op(
  id: string,
  divisionId: string,
  workerId: string,
  title: string,
  description: string,
  status: ForgeSnapshot["operations"][number]["status"],
  progress: number,
  outputArtifactIds: string[],
  blockedReason?: string
) {
  return { id, divisionId, workerId, title, description, status, priority: "high", progress, blockedReason, retryCount: 0, outputArtifactIds, routingStage: status === "completed" ? "done" : "worker_ready", webAccessPolicy: "none" };
}

function dep(id: string, operationId: string, dependsOnOperationId: string, type: ForgeSnapshot["dependencies"][number]["type"] = "blocks") {
  return { id, operationId, dependsOnOperationId, type };
}

function artifact(
  id: string,
  title: string,
  type: string,
  divisionId: string,
  workerId: string,
  operationId: string,
  content: string,
  status: ForgeSnapshot["artifacts"][number]["status"],
  tags: string[]
) {
  return { id, title, type, divisionId, workerId, operationId, content, status, version: 1, tags, fileIds: [], createdAt: now, updatedAt: now };
}

function file(
  id: string,
  path: string,
  content: string,
  status: ForgeSnapshot["files"][number]["status"],
  divisionId: string,
  workerId: string,
  operationId: string,
  artifactIds: string[]
) {
  return { id, path, content, status, version: 1, divisionId, workerId, operationId, artifactIds, updatedAt: now };
}

function event(
  forgeId: string,
  idFor: (id: string) => string,
  sequence: number,
  type: ForgeSnapshot["events"][number]["type"],
  actorType: ForgeSnapshot["events"][number]["actorType"],
  targetType: ForgeSnapshot["events"][number]["targetType"],
  targetId: string,
  message: string,
  severity: ForgeSnapshot["events"][number]["severity"]
) {
  return {
    id: idFor(`event-${sequence}`),
    forgeId,
    sequence,
    type,
    actorType,
    targetType,
    targetId,
    message,
    severity,
    payload: {},
    createdAt: now
  };
}
