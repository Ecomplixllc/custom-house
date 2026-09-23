import db from "../app/db.server.ts";

function desiredCollectionDisplayName(displayName: string | null) {
  return `${displayName?.trim() || "Creator"} Designs`.slice(0, 140);
}

async function run() {
  const collections = await db.creatorCollection.findMany({
    include: {
      creator: {
        select: {
          id: true,
          displayName: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  let updated = 0;
  for (const collection of collections) {
    const displayName = desiredCollectionDisplayName(collection.creator.displayName);
    if (collection.displayName === displayName) continue;
    await db.creatorCollection.update({
      where: { id: collection.id },
      data: { displayName },
    });
    updated += 1;
  }

  console.info("creator_collection_display_identity_backfill_complete", {
    scanned: collections.length,
    updated,
    preservedPublicHandles: collections.length,
  });
}

run()
  .catch((error) => {
    console.error("creator_collection_display_identity_backfill_failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
