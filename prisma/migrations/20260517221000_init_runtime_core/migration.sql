-- CreateEnum
CREATE TYPE "ForgeStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "RuntimeStatus" AS ENUM ('idle', 'planning', 'ready', 'running', 'blocked', 'reviewing', 'completed', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "OperationPriority" AS ENUM ('low', 'normal', 'high', 'critical');

-- CreateEnum
CREATE TYPE "OperationDependencyType" AS ENUM ('blocks', 'informs', 'reviews', 'produces_input_for');

-- CreateEnum
CREATE TYPE "ArtifactStatus" AS ENUM ('draft', 'generated', 'reviewed', 'finalized');

-- CreateEnum
CREATE TYPE "RuntimeActorType" AS ENUM ('operator', 'executive', 'division', 'worker', 'runtime');

-- CreateEnum
CREATE TYPE "RuntimeTargetType" AS ENUM ('forge', 'operation', 'artifact', 'worker', 'division', 'file', 'handoff', 'chat');

-- CreateEnum
CREATE TYPE "RuntimeEventSeverity" AS ENUM ('info', 'success', 'warning', 'error');

-- CreateTable
CREATE TABLE "Forge" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "status" "ForgeStatus" NOT NULL DEFAULT 'active',
    "activePhase" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Forge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Division" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "RuntimeStatus" NOT NULL DEFAULT 'idle',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" "RuntimeStatus" NOT NULL DEFAULT 'idle',
    "currentTask" TEXT,
    "contextManifest" JSONB NOT NULL,
    "externalAgentId" TEXT,
    "provider" TEXT,
    "providerMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "workerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "RuntimeStatus" NOT NULL DEFAULT 'planning',
    "priority" "OperationPriority" NOT NULL DEFAULT 'normal',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "blockedReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationDependency" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "dependsOnOperationId" TEXT NOT NULL,
    "type" "OperationDependencyType" NOT NULL DEFAULT 'blocks',
    CONSTRAINT "OperationDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "workerId" TEXT,
    "operationId" TEXT,
    "content" TEXT NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VirtualFile" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "divisionId" TEXT,
    "workerId" TEXT,
    "operationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VirtualFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactFile" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "virtualFileId" TEXT NOT NULL,
    CONSTRAINT "ArtifactFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "fromDivisionId" TEXT NOT NULL,
    "toDivisionId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "deliverables" TEXT[],
    "blockers" TEXT[],
    "requiredContext" TEXT[],
    "confidence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeEvent" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" "RuntimeActorType" NOT NULL,
    "actorId" TEXT,
    "targetType" "RuntimeTargetType",
    "targetId" TEXT,
    "message" TEXT NOT NULL,
    "severity" "RuntimeEventSeverity" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuntimeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeCommandLedger" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuntimeCommandLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForgeSnapshot" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "lastEventSequence" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForgeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutiveMessage" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExecutiveMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Forge_slug_key" ON "Forge"("slug");

-- CreateIndex
CREATE INDEX "Division_forgeId_order_idx" ON "Division"("forgeId", "order");

-- CreateIndex
CREATE INDEX "Worker_forgeId_divisionId_idx" ON "Worker"("forgeId", "divisionId");

-- CreateIndex
CREATE INDEX "Operation_forgeId_status_idx" ON "Operation"("forgeId", "status");

-- CreateIndex
CREATE INDEX "Operation_forgeId_divisionId_idx" ON "Operation"("forgeId", "divisionId");

-- CreateIndex
CREATE INDEX "OperationDependency_forgeId_operationId_idx" ON "OperationDependency"("forgeId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationDependency_operationId_dependsOnOperationId_type_key" ON "OperationDependency"("operationId", "dependsOnOperationId", "type");

-- CreateIndex
CREATE INDEX "Artifact_forgeId_type_idx" ON "Artifact"("forgeId", "type");

-- CreateIndex
CREATE INDEX "VirtualFile_forgeId_status_idx" ON "VirtualFile"("forgeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualFile_forgeId_path_key" ON "VirtualFile"("forgeId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactFile_artifactId_virtualFileId_key" ON "ArtifactFile"("artifactId", "virtualFileId");

-- CreateIndex
CREATE INDEX "Handoff_forgeId_fromDivisionId_toDivisionId_idx" ON "Handoff"("forgeId", "fromDivisionId", "toDivisionId");

-- CreateIndex
CREATE INDEX "RuntimeEvent_forgeId_sequence_idx" ON "RuntimeEvent"("forgeId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeEvent_forgeId_sequence_key" ON "RuntimeEvent"("forgeId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeCommandLedger_key_key" ON "RuntimeCommandLedger"("key");

-- CreateIndex
CREATE INDEX "ForgeSnapshot_forgeId_lastEventSequence_idx" ON "ForgeSnapshot"("forgeId", "lastEventSequence");

-- CreateIndex
CREATE INDEX "ExecutiveMessage_forgeId_createdAt_idx" ON "ExecutiveMessage"("forgeId", "createdAt");

-- AddForeignKey
ALTER TABLE "Division" ADD CONSTRAINT "Division_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationDependency" ADD CONSTRAINT "OperationDependency_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationDependency" ADD CONSTRAINT "OperationDependency_dependsOnOperationId_fkey" FOREIGN KEY ("dependsOnOperationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VirtualFile" ADD CONSTRAINT "VirtualFile_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactFile" ADD CONSTRAINT "ArtifactFile_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactFile" ADD CONSTRAINT "ArtifactFile_virtualFileId_fkey" FOREIGN KEY ("virtualFileId") REFERENCES "VirtualFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeEvent" ADD CONSTRAINT "RuntimeEvent_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForgeSnapshot" ADD CONSTRAINT "ForgeSnapshot_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutiveMessage" ADD CONSTRAINT "ExecutiveMessage_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
