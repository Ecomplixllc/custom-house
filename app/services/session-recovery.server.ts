export function isRecoverableSessionStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "MissingSessionTableError" ||
    error.message.includes("Prisma session table does not exist")
  );
}

export function isTransientDatabaseConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return (
    ["P1001", "P1002", "P2024"].includes(code) ||
    error.message.includes("Timed out fetching a new connection from the connection pool") ||
    error.message.includes("Can't reach database server")
  );
}

export async function withTransientDatabaseRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    retryDelayMs?: number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 2));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 75);
  const wait = options.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDatabaseConnectivityError(error) || attempt === attempts) throw error;
      await wait(retryDelayMs * attempt);
    }
  }
  throw new Error("Transient database retry ended unexpectedly.");
}

export async function withSessionStorageRecovery<T>(
  operation: () => Promise<T>,
  confirmSessionTable: () => Promise<unknown>,
  resetSessionStorage: () => void,
  options: {
    retryDelayMs?: number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isTransientDatabaseConnectivityError(error)) {
      resetSessionStorage();
      const retryDelayMs = Math.max(0, options.retryDelayMs ?? 75);
      const wait = options.wait ?? ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
      await wait(retryDelayMs);
      return operation();
    }
    if (!isRecoverableSessionStorageError(error)) throw error;

    // The Shopify Prisma adapter caches its first table-readiness result.
    // If Neon was temporarily unavailable during a cold start, confirm the
    // table is reachable now, rebuild Shopify, and retry the auth operation.
    await confirmSessionTable();
    resetSessionStorage();
    return operation();
  }
}
