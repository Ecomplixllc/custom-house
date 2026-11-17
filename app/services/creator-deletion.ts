import { DomainError, safeJson } from "./domain.ts";

type CreatorDependencyCounts = {
  creatorProducts: number;
  submissions: number;
  designSessions: number;
  creatorDesigns: number;
  sales: number;
  orderItems: number;
  referredCreators: number;
  referralAttributions: number;
  referralEarningsEarned: number;
  referralEarningsGenerated: number;
  payoutMethods: number;
  payouts: number;
};

type CreatorDeletionRecord = {
  id: string;
  shop: string;
  customerId: string;
  displayName: string;
  handle: string;
  referredByCreatorId: string | null;
  collectionId: string | null;
  creatorProfileMetaobjectId: string | null;
  marketplaceCollection: { id: string } | null;
  _count: CreatorDependencyCounts;
};

type CreatorDeletionReference = Pick<
  CreatorDeletionRecord,
  "id" | "displayName" | "handle"
>;

export type CreatorDeletionEligibility = {
  eligible: boolean;
  blockers: string[];
  creator: CreatorDeletionReference;
};

export type CreatorDeletionDb = {
  creator: {
    findFirst(args: Record<string, unknown>): Promise<CreatorDeletionRecord | null>;
    delete(args: Record<string, unknown>): Promise<unknown>;
  };
  creatorApplication: {
    deleteMany(args: Record<string, unknown>): Promise<unknown>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  $queryRaw?: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
  $transaction<T>(
    callback: (tx: CreatorDeletionDb) => Promise<T>,
    options?: Record<string, unknown>,
  ): Promise<T>;
};

const creatorDeletionInclude = {
  marketplaceCollection: { select: { id: true } },
  _count: {
    select: {
      creatorProducts: true,
      submissions: true,
      designSessions: true,
      creatorDesigns: true,
      sales: true,
      orderItems: true,
      referredCreators: true,
      referralAttributions: true,
      referralEarningsEarned: true,
      referralEarningsGenerated: true,
      payoutMethods: true,
      payouts: true,
    },
  },
} as const;

function dependencyBlockers(creator: CreatorDeletionRecord) {
  const blockers: string[] = [];
  const counts = creator._count;
  if (counts.creatorProducts) blockers.push("Creator products");
  if (counts.orderItems) blockers.push("Creator order history");
  if (counts.sales) blockers.push("Creator sales, commissions, earnings, or adjustments");
  if (counts.payoutMethods || counts.payouts) {
    blockers.push("payout methods, payouts, or payout allocations");
  }
  if (
    creator.referredByCreatorId ||
    counts.referredCreators ||
    counts.referralAttributions ||
    counts.referralEarningsEarned ||
    counts.referralEarningsGenerated
  ) {
    blockers.push("referral relationship");
  }
  if (counts.submissions || counts.designSessions || counts.creatorDesigns) {
    blockers.push("Creator design or submission history");
  }
  if (creator.collectionId || creator.marketplaceCollection) {
    blockers.push("Creator collection or publication mapping");
  }
  if (creator.creatorProfileMetaobjectId) {
    blockers.push("Creator profile metaobject mapping");
  }
  return blockers;
}

export async function getCreatorDeletionEligibility(
  shop: string,
  creatorId: string,
  database: CreatorDeletionDb,
): Promise<CreatorDeletionEligibility> {
  const creator = await database.creator.findFirst({
    where: { id: creatorId, shop },
    include: creatorDeletionInclude,
  });
  if (!creator) {
    throw new DomainError("NOT_FOUND", "Creator not found.", 404);
  }
  const blockers = dependencyBlockers(creator);
  return {
    eligible: blockers.length === 0,
    blockers,
    creator: {
      id: creator.id,
      displayName: creator.displayName,
      handle: creator.handle,
    },
  };
}

export async function deleteCreatorPermanently(
  shop: string,
  creatorId: string,
  confirmation: unknown,
  database: CreatorDeletionDb,
): Promise<CreatorDeletionReference> {
  if (confirmation !== "DELETE") {
    throw new DomainError(
      "CREATOR_DELETE_CONFIRMATION",
      "Type DELETE to permanently delete this Creator profile.",
      422,
    );
  }

  return database.$transaction(async (tx) => {
    if (tx.$queryRaw) {
      await tx.$queryRaw`SELECT id FROM "Creator" WHERE id = ${creatorId} AND shop = ${shop} FOR UPDATE`;
    }
    const eligibility = await getCreatorDeletionEligibility(shop, creatorId, tx);
    if (!eligibility.eligible) {
      throw new DomainError(
        "CREATOR_DELETE_BLOCKED",
        "This Creator has historical or financial records and cannot be permanently deleted. Deactivate the Creator instead.",
        409,
      );
    }

    await tx.creatorApplication.deleteMany({
      where: { creatorId, shop },
    });
    await tx.auditLog.create({
      data: {
        shop,
        actorType: "ADMIN",
        action: "creator.deleted_permanently",
        entityType: "Creator",
        entityId: creatorId,
        beforeJson: safeJson({
          id: eligibility.creator.id,
          displayName: eligibility.creator.displayName,
          handle: eligibility.creator.handle,
        }),
        afterJson: safeJson({
          deleted: true,
          shopifyCustomerPreserved: true,
        }),
      },
    });
    await tx.creator.delete({ where: { id: creatorId } });
    return eligibility.creator;
  });
}
