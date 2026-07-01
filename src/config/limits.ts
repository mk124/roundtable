import type { SizeLimits } from '../types.ts';

const KiB = 1024;
const MiB = 1024 * 1024;

/**
 * Passive chat-room byte budgets. All limits are configurable and measured
 * in UTF-8 bytes of the final escaped + framed text.
 */
export const DEFAULT_SIZE_LIMITS: SizeLimits = {
  messageBytes: 512 * KiB,
  singleEventBytes: 1 * MiB,
  conversationTotalBytes: 50 * MiB,
};

/** UTF-8 byte length; the unit every size limit is measured in. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
