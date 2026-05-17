import { LogsPage } from "@/components/forge/forge-pages";
import { runtimeStore } from "@/lib/runtime/store";

export const dynamic = "force-dynamic";

export default async function LogsRoute() {
  return <LogsPage initialSnapshot={await runtimeStore.getSnapshot()} />;
}
