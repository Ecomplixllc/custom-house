import { createHash } from "node:crypto";
export function submissionKey(shop: string, creatorId: string, productId: string, url: string): string { return createHash("sha256").update([shop, creatorId, productId, url].join("\n")).digest("hex"); }
