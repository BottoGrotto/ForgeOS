ALTER TYPE "RuntimeStatus" ADD VALUE IF NOT EXISTS 'archived';
ALTER TYPE "RuntimeTargetType" ADD VALUE IF NOT EXISTS 'run';

CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "workerId" TEXT,
    "provider" TEXT NOT NULL,
    "externalRunId" TEXT,
    "status" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "usage" JSONB,
    "rateLimit" JSONB,
    "providerMetadata" JSONB NOT NULL,
    "error" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRun_forgeId_status_idx" ON "AgentRun"("forgeId", "status");
CREATE INDEX "AgentRun_forgeId_operationId_idx" ON "AgentRun"("forgeId", "operationId");
CREATE INDEX "AgentRun_provider_externalRunId_idx" ON "AgentRun"("provider", "externalRunId");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_forgeId_fkey"
  FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentRunClaim" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "workerId" TEXT,
    "provider" TEXT NOT NULL,
    "claimedBy" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRunClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentRunClaim_runId_key" ON "AgentRunClaim"("runId");
CREATE UNIQUE INDEX "AgentRunClaim_forgeId_operationId_key" ON "AgentRunClaim"("forgeId", "operationId");
CREATE UNIQUE INDEX "AgentRunClaim_forgeId_workerId_key" ON "AgentRunClaim"("forgeId", "workerId");
CREATE INDEX "AgentRunClaim_forgeId_leaseExpiresAt_idx" ON "AgentRunClaim"("forgeId", "leaseExpiresAt");
