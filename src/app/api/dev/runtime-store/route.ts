import { NextRequest } from "next/server";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

export async function GET() {
  return apiJson({ storage: runtimeStore.getStorageInfo() });
}

export async function DELETE(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    await runtimeStore.clearLocalForges();
    return apiJson({ storage: runtimeStore.getStorageInfo(), forges: await runtimeStore.listForges() });
  } catch (error) {
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Local Forge storage reset failed", 500);
  }
}
