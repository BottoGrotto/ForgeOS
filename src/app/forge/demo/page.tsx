import { runtimeStore } from "@/lib/runtime/store";
import { OverviewPage } from "@/components/forge/forge-pages";

export const dynamic = "force-dynamic";

export default async function DemoForgePage() {
  return <OverviewPage initialSnapshot={await runtimeStore.getSnapshot()} />;
}
