export function isRecoverableSessionStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "MissingSessionTableError" ||
    error.message.includes("Prisma session table does not exist")
  );
}

export async function withSessionStorageRecovery<T>(
  operation: () => Promise<T>,
  confirmSessionTable: () => Promise<unknown>,
  resetSessionStorage: () => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRecoverableSessionStorageError(error)) throw error;

    // The Shopify Prisma adapter caches its first table-readiness result.
    // If Neon was temporarily unavailable during a cold start, confirm the
    // table is reachable now, rebuild Shopify, and retry the auth operation.
    await confirmSessionTable();
    resetSessionStorage();
    return operation();
  }
}
