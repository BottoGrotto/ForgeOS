import { WorkspacePage } from "@/components/forge/forge-pages";
import { runtimeStore } from "@/lib/runtime/store";

export const dynamic = "force-dynamic";

export default async function WorkspaceRoute() {
  return <WorkspacePage initialSnapshot={await runtimeStore.getSnapshot()} />;
}
