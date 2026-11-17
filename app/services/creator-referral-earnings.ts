import { Prisma } from "@prisma/client";
import { creatorEarning } from "./creator-sales.ts";
import { decimalMoneyToMinorUnits } from "./money.ts";
export { decimalMoneyToMinorUnits } from "./money.ts";

export const CREATOR_REFERRAL_RATE_BPS = 200;

export function calculateReferralEarning(input: {
  creatorEarningMinor: bigint | number;
  rateBps?: number;
}) {
  const creatorEarningMinor = BigInt(input.creatorEarningMinor);
  const rateBps = BigInt(input.rateBps ?? CREATOR_REFERRAL_RATE_BPS);
  if (creatorEarningMinor <= 0n || rateBps <= 0n) return 0n;
  return (creatorEarningMinor * rateBps + 5_000n) / 10_000n;
}

export function creatorEarningMinorFromSalesAmount(
  salesAmount: Prisma.Decimal,
  commissionRateBps: number,
) {
  return decimalMoneyToMinorUnits(creatorEarning(salesAmount, commissionRateBps));
}
