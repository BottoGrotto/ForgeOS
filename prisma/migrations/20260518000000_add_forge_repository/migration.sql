-- AlterEnum
ALTER TYPE "RuntimeTargetType" ADD VALUE 'repository';

-- CreateTable
CREATE TABLE "ForgeRepository" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "workingBranch" TEXT NOT NULL,
    "installationId" TEXT,
    "accountRef" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "lastRefreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForgeRepository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ForgeRepository_forgeId_key" ON "ForgeRepository"("forgeId");

-- CreateIndex
CREATE INDEX "ForgeRepository_provider_owner_repo_idx" ON "ForgeRepository"("provider", "owner", "repo");

-- AddForeignKey
ALTER TABLE "ForgeRepository" ADD CONSTRAINT "ForgeRepository_forgeId_fkey" FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
