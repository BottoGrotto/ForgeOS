import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson } from "@/lib/security/request";

export async function GET(_request: Request, context: { params: Promise<{ forgeSlug: string }> }) {
  const { forgeSlug } = await context.params;
  try {
    return apiJson({ repositories: await runtimeStore.listGitHubRepositories(forgeSlug) });
  } catch (error) {
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("GitHub repositories load failed", 500);
  }
}
