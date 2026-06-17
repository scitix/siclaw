import type { DelegationAppendMessagePayload } from "../../shared/delegation-persistence.js";
import { hasImageAttachmentsInMetadata } from "./visual-image.js";

export type BackgroundChannelDelivery = (message: DelegationAppendMessagePayload) => Promise<boolean>;

interface DeliveryEntry {
  deliver: BackgroundChannelDelivery;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const deliveries = new Map<string, DeliveryEntry>();

export function registerBackgroundChannelDelivery(
  sessionId: string,
  deliver: BackgroundChannelDelivery,
  ttlMs: number = DEFAULT_TTL_MS,
): () => void {
  clearBackgroundChannelDelivery(sessionId);
  const expiresAt = Date.now() + ttlMs;
  const timer = setTimeout(() => clearBackgroundChannelDelivery(sessionId), ttlMs);
  timer.unref?.();
  deliveries.set(sessionId, { deliver, expiresAt, timer });
  return () => clearBackgroundChannelDelivery(sessionId);
}

export function clearBackgroundChannelDelivery(sessionId: string): void {
  const existing = deliveries.get(sessionId);
  if (existing) clearTimeout(existing.timer);
  deliveries.delete(sessionId);
}

export function hasBackgroundChannelDelivery(sessionId: string | undefined): boolean {
  return Boolean(sessionId && getEntry(sessionId));
}

export async function deliverBackgroundChannelMessage(
  message: DelegationAppendMessagePayload,
): Promise<boolean> {
  const hasAssistantText = message.role === "assistant" && message.content.trim().length > 0;
  const hasImages = hasImageAttachmentsInMetadata(message.metadata);
  if (!hasAssistantText && !hasImages) return false;
  const entry = getEntry(message.sessionId);
  if (!entry) return false;
  return entry.deliver(message);
}

function getEntry(sessionId: string | undefined): DeliveryEntry | undefined {
  if (!sessionId) return undefined;
  const entry = deliveries.get(sessionId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    clearBackgroundChannelDelivery(sessionId);
    return undefined;
  }
  return entry;
}
