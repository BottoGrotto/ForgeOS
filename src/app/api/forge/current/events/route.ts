import { NextRequest } from "next/server";
import { runtimeStore } from "@/lib/runtime/store";
import { apiJson } from "@/lib/security/request";

export async function GET(request: NextRequest) {
  const afterSequence = Number(request.nextUrl.searchParams.get("afterSequence") ?? "0");
  return apiJson(await runtimeStore.getEvents(Number.isFinite(afterSequence) ? afterSequence : 0));
}
