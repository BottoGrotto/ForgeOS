import { NextRequest } from "next/server";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, getAuthenticatedOperatorSession } from "@/lib/security/request";

export async function GET(request: NextRequest, context: { params: Promise<{ forgeSlug: string }> }) {
  if (!getAuthenticatedOperatorSession(request)) {
    return apiError("Authentication required", 401);
  }

  const { forgeSlug } = await context.params;
  const afterSequence = Number(request.nextUrl.searchParams.get("afterSequence") ?? "0");
  try {
    return apiJson(await runtimeStore.getEvents(forgeSlug, Number.isFinite(afterSequence) ? afterSequence : 0));
  } catch (error) {
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Events load failed", 500);
  }
}
