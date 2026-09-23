import { DomainError } from "./domain";
const buckets = new Map<string, { count: number; resets: number }>();
export function enforceRateLimit(key: string, max = 20, windowMs = 60_000): void { const now = Date.now(); const old = buckets.get(key); const bucket = !old || old.resets <= now ? { count: 0, resets: now + windowMs } : old; bucket.count += 1; buckets.set(key, bucket); if (bucket.count > max) throw new DomainError("RATE_LIMITED", "Too many requests. Try again shortly.", 429); }
