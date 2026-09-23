import {
  canApprovedCreatorPublish,
  isSuspendedCreatorStatus,
  normalizeCreatorStatus,
} from "./creator-status.ts";

export type StorefrontCreatorStatus = string;

export type StorefrontActorRole = "GUEST" | "CUSTOMER" | "CREATOR";

export type AuthorizedDesignerMode =
  | "CUSTOMER_BUY"
  | "CREATOR_BUY"
  | "CREATOR_PUBLISH";

export type StorefrontActor = {
  customerId: string | null;
  role: StorefrontActorRole;
  creatorId: string | null;
  creatorStatus: StorefrontCreatorStatus | null;
  rawCreatorStatus: StorefrontCreatorStatus | null;
  normalizedCreatorStatus: string;
  isCreator: boolean;
  isApprovedCreator: boolean;
  isSuspendedCreator: boolean;
  isSuspended: boolean;
  authorizedDesignerModes: AuthorizedDesignerMode[];
};

export function normalizeStorefrontActor(input: {
  customerId: string | null;
  creator: {
    id: string;
    status: unknown;
    suspendedAt: Date | string | null;
  } | null;
}): StorefrontActor {
  const rawCreatorStatus =
    typeof input.creator?.status === "string"
      ? input.creator.status
      : null;
  const normalizedCreatorStatus =
    normalizeCreatorStatus(rawCreatorStatus);
  const isSuspendedCreator = Boolean(
    input.creator &&
      (isSuspendedCreatorStatus(rawCreatorStatus) ||
        input.creator.suspendedAt),
  );
  const isApprovedCreator = Boolean(
    input.creator &&
      canApprovedCreatorPublish(
        rawCreatorStatus,
        input.creator.suspendedAt,
      ),
  );
  const isCreator = Boolean(input.creator);
  return {
    customerId: input.customerId,
    role: isCreator
      ? "CREATOR"
      : input.customerId
        ? "CUSTOMER"
        : "GUEST",
    creatorId: input.creator?.id ?? null,
    creatorStatus: rawCreatorStatus,
    rawCreatorStatus,
    normalizedCreatorStatus,
    isCreator,
    isApprovedCreator,
    isSuspendedCreator,
    isSuspended: isSuspendedCreator,
    authorizedDesignerModes: [
      "CUSTOMER_BUY",
      ...(isApprovedCreator
        ? (["CREATOR_BUY", "CREATOR_PUBLISH"] as const)
        : []),
    ],
  };
}
