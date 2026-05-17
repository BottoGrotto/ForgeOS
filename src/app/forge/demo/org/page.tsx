import { OrganizationPage } from "@/components/forge/forge-pages";
import { runtimeStore } from "@/lib/runtime/store";

export const dynamic = "force-dynamic";

export default async function OrgPage() {
  return <OrganizationPage initialSnapshot={await runtimeStore.getSnapshot()} />;
}
