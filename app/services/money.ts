import { Prisma } from "@prisma/client";

export const MINOR_UNITS_PER_MAJOR = 100n;

function currencySuffix(currencyCode: string) {
  return currencyCode.toUpperCase() === "SEK" ? "kr" : currencyCode.toUpperCase();
}

function fixedMajorFromMinor(amountMinor: bigint | number) {
  const minor = BigInt(amountMinor);
  const sign = minor < 0n ? "-" : "";
  const absolute = minor < 0n ? -minor : minor;
  const major = absolute / MINOR_UNITS_PER_MAJOR;
  const cents = absolute % MINOR_UNITS_PER_MAJOR;
  return `${sign}${major}.${cents.toString().padStart(2, "0")}`;
}

export function formatMinorMoney(
  amountMinor: bigint | number,
  currencyCode: string,
) {
  return `${fixedMajorFromMinor(amountMinor)} ${currencySuffix(currencyCode)}`;
}

export function decimalMoneyToMinorUnits(amount: Prisma.Decimal) {
  return BigInt(
    amount
      .mul(Number(MINOR_UNITS_PER_MAJOR))
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toString(),
  );
}

export function formatDecimalMoney(
  amount: Prisma.Decimal,
  currencyCode: string,
) {
  return formatMinorMoney(decimalMoneyToMinorUnits(amount), currencyCode);
}
