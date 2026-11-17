/**
 * The database-neutral rules of the bookmark (conversation tag) counts that other stores adjust,
 * shared by the MongoDB methods (`./conversationTag`) and the PostgreSQL conversation store.
 * Nothing here may import `mongoose` or touch a model.
 */

/** One update of a bulk write: a filter and an update in the query language both backends speak. */
export interface TagCountUpdate {
  updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> };
}

/**
 * The writes that lower the user's tag counts by one per entry of `tags` (a tag may repeat), in
 * order, never below zero; empty when there is nothing to lower.
 *
 * Each tag emits three writes in one ordered bulk write instead of a `$max`/`$subtract`
 * aggregation-pipeline update (which Amazon DocumentDB rejects): normalize a null/missing count
 * to zero, apply the `$inc`, then clamp a negative result back to zero. The clamp keys on
 * `count < 0` rather than `count < amount` so it composes with concurrent decrements of the same
 * tag: increments commute and every interleaved call ends with its own clamp, so the count still
 * converges on `max(0, ...)` exactly as the serialized pipeline did. The only trade-off is a
 * transiently negative count between a write pair, which readers already tolerate.
 */
export function tagCountDecrements(user: string, tags: string[]): TagCountUpdate[] {
  const decrementByTag = new Map<string, number>();
  for (const tag of tags) {
    if (!tag) {
      continue;
    }
    decrementByTag.set(tag, (decrementByTag.get(tag) ?? 0) + 1);
  }
  return [...decrementByTag.entries()].flatMap(([tag, amount]) => [
    {
      updateOne: {
        filter: { user, tag, count: null },
        update: { $set: { count: 0 } },
      },
    },
    {
      updateOne: {
        filter: { user, tag },
        update: { $inc: { count: -amount } },
      },
    },
    {
      updateOne: {
        filter: { user, tag, count: { $lt: 0 } },
        update: { $set: { count: 0 } },
      },
    },
  ]);
}
