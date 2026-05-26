import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

export async function GET(_request: Request, context: { params: Promise<{ forgeSlug: string }> }) {
  const { forgeSlug } = await context.params;
  try {
    return apiJson((await runtimeStore.getSnapshot(forgeSlug)).files);
  } catch (error) {
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Workspace files load failed", 500);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ forgeSlug: string }> }) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  const { forgeSlug } = await context.params;
  try {
    return apiJson(await runtimeStore.upsertVirtualFile(forgeSlug, await request.json()));
  } catch (error) {
    if (error instanceof ZodError) {
      const detail = error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ");
      return apiError(detail ? `Invalid workspace file: ${detail}` : "Invalid workspace file", 400);
    }
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Workspace file save failed", 500);
  }
}
