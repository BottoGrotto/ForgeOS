import { NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

const syncSchema = z.object({
  owner: z.string().min(1).max(80),
  repo: z.string().min(1).max(120),
  ref: z.string().min(1).max(255).optional(),
  idempotencyKey: z.string().max(120).optional()
});

export async function POST(request: NextRequest, context: { params: Promise<{ forgeSlug: string }> }) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  const { forgeSlug } = await context.params;
  try {
    const body = syncSchema.parse(await request.json());
    return apiJson(await runtimeStore.syncGitHubRepository(forgeSlug, body));
  } catch (error) {
    if (error instanceof ZodError) {
      return apiError("Invalid repository sync request", 400);
    }
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("GitHub repository sync failed", 500);
  }
}
