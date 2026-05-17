import { NextRequest } from "next/server";
import { runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const body = await request.json();
    if (typeof body.message !== "string" || body.message.trim().length === 0 || body.message.length > 2000) {
      return apiError("Message is required", 400);
    }

    return apiJson(
      await runtimeStore.dispatch({
        type: "operator_message",
        message: body.message,
        idempotencyKey: body.idempotencyKey
      })
    );
  } catch {
    return apiError("Executive message failed", 500);
  }
}
