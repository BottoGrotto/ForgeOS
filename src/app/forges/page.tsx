import { ForgesIndex } from "@/components/forge/forges-index";
import { runtimeStore } from "@/lib/runtime/store";

export const dynamic = "force-dynamic";

export default async function ForgesPage() {
  return <ForgesIndex forges={await runtimeStore.listForges()} />;
}
