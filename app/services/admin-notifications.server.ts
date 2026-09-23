import db from "../db.server.ts";
import { safeJson } from "./domain.ts";

type NotifyInput = {
  shop: string;
  type: string;
  title: string;
  message: string;
  entityType: string;
  entityId: string;
  actionUrl?: string | null;
  metadata?: Record<string, unknown>;
};

export async function createAdminNotification(input: NotifyInput) {
  return db.adminNotification.create({
    data: {
      shop: input.shop,
      type: input.type,
      title: input.title,
      message: input.message,
      entityType: input.entityType,
      entityId: input.entityId,
      actionUrl: input.actionUrl,
      metadataJson: safeJson(input.metadata || {}),
    },
  });
}

export async function markAdminNotificationRead(shop: string, id: string) {
  return db.adminNotification.updateMany({
    where: { shop, id, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function markAllAdminNotificationsRead(shop: string) {
  return db.adminNotification.updateMany({
    where: { shop, readAt: null },
    data: { readAt: new Date() },
  });
}
