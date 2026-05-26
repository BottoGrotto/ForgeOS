import { NextRequest } from "next/server";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, getAuthenticatedOperatorSession } from "@/lib/security/request";

export async function GET(request: NextRequest, context: { params: Promise<{ forgeSlug: string }> }) {
  if (!getAuthenticatedOperatorSession(request)) {
    return apiError("Authentication required", 401);
  }

  const { forgeSlug } = await context.params;
  try {
    return apiJson(await runtimeStore.getSnapshot(forgeSlug));
  } catch (error) {
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Snapshot load failed", 500);
  }
}
