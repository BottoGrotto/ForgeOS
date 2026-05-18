import { z } from "zod";

const API_VERSION = "2022-11-28";
const MAX_SYNC_FILES = 30;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".env.example", ".gitignore", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".prisma", ".sql", ".ts", ".tsx", ".txt", ".yaml", ".yml"
]);

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  scope: z.string().default("")
});

const userSchema = z.object({
  id: z.number(),
  login: z.string()
});

const repoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  updated_at: z.string().nullable().optional(),
  owner: z.object({ login: z.string() })
});

const treeSchema = z.object({
  tree: z.array(z.object({
    path: z.string(),
    type: z.string(),
    size: z.number().optional()
  })),
  truncated: z.boolean().optional()
});

export interface GitHubRepositorySummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt?: string;
}

export interface GitHubSyncedFile {
  path: string;
  content: string;
}

export async function exchangeGitHubOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier
    })
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error("GitHub OAuth token exchange failed.");
  }

  const token = tokenResponseSchema.parse(payload);
  return {
    accessToken: token.access_token,
    tokenType: token.token_type,
    scopes: token.scope ? token.scope.split(",").filter(Boolean) : []
  };
}

export async function fetchGitHubAuthenticatedUser(accessToken: string) {
  const payload = await githubJson("https://api.github.com/user", accessToken);
  const user = userSchema.parse(payload);
  return { id: String(user.id), login: user.login };
}

export async function listGitHubRepositories(accessToken: string): Promise<GitHubRepositorySummary[]> {
  const payload = await githubJson("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", accessToken);
  const repos = z.array(repoSchema).parse(payload);
  return repos.map((repo) => ({
    id: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at ?? undefined
  }));
}

export async function syncGitHubRepositoryFiles(accessToken: string, input: { owner: string; repo: string; ref: string }): Promise<GitHubSyncedFile[]> {
  validateRepositoryInput(input.owner, input.repo, input.ref);
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees/${encodeURIComponent(input.ref)}?recursive=1`;
  const payload = await githubJson(treeUrl, accessToken);
  const tree = treeSchema.parse(payload);
  const candidates = tree.tree
    .filter((item) => item.type === "blob" && isSafeTextPath(item.path) && (item.size ?? 0) <= MAX_FILE_BYTES)
    .slice(0, MAX_SYNC_FILES);

  const files: GitHubSyncedFile[] = [];
  let totalBytes = 0;
  for (const item of candidates) {
    const content = await fetchGitHubRawFile(accessToken, input.owner, input.repo, item.path, input.ref);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES || totalBytes + bytes > MAX_TOTAL_BYTES) {
      continue;
    }
    totalBytes += bytes;
    files.push({ path: item.path, content });
  }

  return files;
}

async function githubJson(url: string, accessToken: string) {
  const response = await fetch(url, {
    headers: githubHeaders(accessToken)
  });
  if (!response.ok) {
    throw new Error("GitHub API request failed.");
  }
  return response.json();
}

async function fetchGitHubRawFile(accessToken: string, owner: string, repo: string, filePath: string, ref: string) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
  const response = await fetch(url, {
    headers: {
      ...githubHeaders(accessToken),
      accept: "application/vnd.github.raw+json"
    }
  });
  if (!response.ok) {
    throw new Error("GitHub file content request failed.");
  }
  return response.text();
}

function githubHeaders(accessToken: string) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "ForgeOS"
  };
}

function validateRepositoryInput(owner: string, repo: string, ref: string) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || owner.startsWith("-") || owner.endsWith("-")) {
    throw new Error("Invalid GitHub owner.");
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") {
    throw new Error("Invalid GitHub repository.");
  }
  if (ref.length === 0 || ref.length > 255 || ref.includes("..") || ref.includes("\\") || /[\u0000-\u001f\u007f~^:?*[{]/.test(ref)) {
    throw new Error("Invalid GitHub ref.");
  }
}

function isSafeTextPath(filePath: string) {
  if (filePath.startsWith("/") || filePath.includes("..") || filePath.includes("\\") || filePath.includes("\0")) {
    return false;
  }
  const lower = filePath.toLowerCase();
  if (lower.startsWith(".git/") || lower.includes("/.git/") || lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".pdf")) {
    return false;
  }
  return TEXT_EXTENSIONS.has(extensionFor(lower)) || /^[^.]+$/.test(filePath.split("/").at(-1) ?? "");
}

function extensionFor(filePath: string) {
  if (filePath.endsWith(".env.example")) {
    return ".env.example";
  }
  const index = filePath.lastIndexOf(".");
  return index >= 0 ? filePath.slice(index) : "";
}
