import { runtimeStore } from "@/lib/runtime/store";
import { apiJson } from "@/lib/security/request";

export async function GET() {
  return apiJson((await runtimeStore.getSnapshot()).files);
}
