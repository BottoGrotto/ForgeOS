import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson } from "@/lib/security/request";

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
