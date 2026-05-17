import { PrismaClient } from "@prisma/client";
import { createDemoSnapshot } from "../src/lib/mock/seed";
import { PrismaRuntimePersistence } from "../src/lib/runtime/prisma";

const prisma = new PrismaClient();

async function main() {
  const snapshot = createDemoSnapshot();
  await new PrismaRuntimePersistence(prisma).resetSnapshot(snapshot);

  console.log(`Seeded ${snapshot.forge.name}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
