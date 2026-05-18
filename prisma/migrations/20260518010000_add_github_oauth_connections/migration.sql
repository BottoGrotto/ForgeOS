CREATE TABLE "GitHubOAuthConnection" (
    "id" TEXT NOT NULL,
    "forgeId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scopes" TEXT[],
    "tokenType" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubOAuthConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitHubOAuthConnection_forgeId_key" ON "GitHubOAuthConnection"("forgeId");
CREATE INDEX "GitHubOAuthConnection_accountLogin_idx" ON "GitHubOAuthConnection"("accountLogin");

ALTER TABLE "GitHubOAuthConnection" ADD CONSTRAINT "GitHubOAuthConnection_forgeId_fkey"
  FOREIGN KEY ("forgeId") REFERENCES "Forge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
