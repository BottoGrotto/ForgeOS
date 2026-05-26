import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

export async function POST(request: NextRequest, context: { params: Promise<{ forgeSlug: string }> }) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  const { forgeSlug } = await context.params;
  try {
    const body = await request.json();
    return apiJson(await runtimeStore.dispatch(forgeSlug, body));
  } catch (error) {
    if (error instanceof ZodError) {
      const detail = error.issues.map((issue) => `${issue.path.join(".") || "command"}: ${issue.message}`).join("; ");
      return apiError(detail ? `Invalid runtime command: ${detail}` : "Invalid runtime command", 400);
    }
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    const detail = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 240) : "";
    return apiError(detail ? `Runtime command failed: ${detail}` : "Runtime command failed", 500);
  }
}
