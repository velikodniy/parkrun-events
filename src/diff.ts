import type { CatalogueDiff, HashedEvent } from "./model.ts";

export const MAX_UNCONFIRMED_CHANGES = 100;
export const MAX_UNCONFIRMED_RATIO = 0.10;

export function changedEventCount(diff: CatalogueDiff): number {
  return diff.appeared.length + diff.disappeared.length + diff.updated.length;
}

export function anomalyRequiresConfirmation(
  diff: CatalogueDiff,
  previousEventCount: number,
): boolean {
  if (previousEventCount <= 0) return false;
  const changed = changedEventCount(diff);
  return changed > MAX_UNCONFIRMED_CHANGES ||
    changed / previousEventCount > MAX_UNCONFIRMED_RATIO;
}

export function confirmsPendingChanges(
  pending: CatalogueDiff,
  candidateEventsById: ReadonlyMap<number, HashedEvent>,
): boolean {
  for (const change of pending.appeared) {
    if (candidateEventsById.get(change.id)?.hash !== change.afterHash) {
      return false;
    }
  }
  for (const change of pending.disappeared) {
    if (candidateEventsById.has(change.id)) return false;
  }
  for (const change of pending.updated) {
    if (candidateEventsById.get(change.id)?.hash !== change.afterHash) {
      return false;
    }
  }
  return true;
}
