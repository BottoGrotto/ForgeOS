import { notFound } from "next/navigation";
import { WorkspacePage } from "@/components/forge/forge-pages";
import { runtimeStore } from "@/lib/runtime/store";

export const dynamic = "force-dynamic";

export default async function WorkspaceRoute({ params }: { params: Promise<{ forgeSlug: string }> }) {
  const { forgeSlug } = await params;
  try {
    return <WorkspacePage initialSnapshot={await runtimeStore.getSnapshot(forgeSlug)} />;
  } catch (error) {
    if (isNotFoundError(error)) {
      notFound();
    }
    throw error;
  }
}

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}
