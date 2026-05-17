import { OperationsPage } from "@/components/forge/forge-pages";
import { runtimeStore } from "@/lib/runtime/store";

export const dynamic = "force-dynamic";

export default async function OperationsRoute() {
  return <OperationsPage initialSnapshot={await runtimeStore.getSnapshot()} />;
}
