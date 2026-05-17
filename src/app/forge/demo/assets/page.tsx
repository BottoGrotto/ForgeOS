import { AssetsPage } from "@/components/forge/forge-pages";
import { runtimeStore } from "@/lib/runtime/store";

export const dynamic = "force-dynamic";

export default async function AssetsRoute() {
  return <AssetsPage initialSnapshot={await runtimeStore.getSnapshot()} />;
}
