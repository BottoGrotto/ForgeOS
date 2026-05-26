import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { RuntimeCommandError, runtimeStore } from "@/lib/runtime/store";
import { apiError, apiJson, assertSameOrigin } from "@/lib/security/request";

export async function GET() {
  return apiJson({ forges: await runtimeStore.listForges() });
}

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const body = await request.json();
    const forge = await runtimeStore.createForge(body);
    return apiJson({ forge }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return apiError("Invalid Forge name", 400);
    }
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Forge creation failed", 500);
  }
}

export async function DELETE(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const body = await request.json();
    return apiJson(await runtimeStore.deleteForges(body));
  } catch (error) {
    if (error instanceof ZodError) {
      return apiError("Invalid Forge selection", 400);
    }
    if (error instanceof RuntimeCommandError) {
      return apiError(error.message, error.status);
    }
    return apiError("Forge deletion failed", 500);
  }
}
