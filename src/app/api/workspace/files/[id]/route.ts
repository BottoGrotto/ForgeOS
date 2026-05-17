import { runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson } from "@/lib/security/request";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const file = (await runtimeStore.getSnapshot()).files.find((candidate) => candidate.id === params.id);
  if (!file) {
    return apiError("Virtual file not found", 404);
  }

  return apiJson(file);
}
