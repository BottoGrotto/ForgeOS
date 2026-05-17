import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const body = await request.json();
    return apiJson(await runtimeStore.dispatch(body));
  } catch (error) {
    if (error instanceof ZodError) {
      return apiError("Invalid runtime command", 400);
    }
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Runtime command failed", 500);
  }
}
