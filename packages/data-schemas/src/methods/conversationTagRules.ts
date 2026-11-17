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

/**
 * The write that shifts the user's tags between a moved tag's old and new positions by one
 * (down when it moves later, up when it moves earlier); `null` when it does not move.
 */
export function tagPositionShift(
  user: string,
  oldPosition: number,
  newPosition: number,
): { filter: Record<string, unknown>; update: Record<string, unknown> } | null {
  if (oldPosition === newPosition) {
    return null;
  }

  const update = oldPosition < newPosition ? { $inc: { position: -1 } } : { $inc: { position: 1 } };
  const position =
    oldPosition < newPosition
      ? {
          $gt: Math.min(oldPosition, newPosition),
          $lte: Math.max(oldPosition, newPosition),
        }
      : {
          $gte: Math.min(oldPosition, newPosition),
          $lt: Math.max(oldPosition, newPosition),
        };

  return { filter: { user, position }, update };
}

/** One update of a bulk write that may insert the tag it counts. */
export interface TagCountUpsert {
  updateOne: {
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
    upsert?: boolean;
  };
}

/**
 * The writes of retagging a conversation from `oldTags` to `newTags`: one more for each tag
 * added (creating the user's tag when missing, at the schema's default position) and one less
 * for each tag removed; empty when nothing changes.
 */
export function tagCountChanges(
  user: string,
  oldTags: ReadonlySet<string>,
  newTags: ReadonlySet<string>,
): TagCountUpsert[] {
  const addedTags = [...newTags].filter((tag) => !oldTags.has(tag));
  const removedTags = [...oldTags].filter((tag) => !newTags.has(tag));

  const bulkOps: TagCountUpsert[] = [];

  for (const tag of addedTags) {
    bulkOps.push({
      updateOne: {
        filter: { user, tag },
        update: { $inc: { count: 1 } },
        upsert: true,
      },
    });
  }

  for (const tag of removedTags) {
    bulkOps.push({
      updateOne: {
        filter: { user, tag },
        update: { $inc: { count: -1 } },
      },
    });
  }

  return bulkOps;
}
