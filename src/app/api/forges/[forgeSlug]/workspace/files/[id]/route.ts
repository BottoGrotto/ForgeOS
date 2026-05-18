import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson } from "@/lib/security/request";

export async function GET(_request: Request, context: { params: Promise<{ forgeSlug: string; id: string }> }) {
  const { forgeSlug, id } = await context.params;
  try {
    const file = (await runtimeStore.getSnapshot(forgeSlug)).files.find((candidate) => candidate.id === id);
    if (!file) {
      return apiError("Virtual file not found", 404);
    }
    return apiJson(file);
  } catch (error) {
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Workspace file load failed", 500);
  }
}
