/**
 * The tool favorite store's database-neutral rules (`ToolFavoriteStore`, `~/ports/favorite`),
 * shared by every backend: the MongoDB methods (`./favorite`) and the PostgreSQL store
 * (`adapters/postgres/stores/toolFavorite.ts`). Nothing here may import `mongoose` or the MongoDB
 * driver.
 */

/** The most favorites a user keeps (a soft cap: concurrent adds may overshoot it by one or two). */
export const MAX_TOOL_FAVORITES = 100;

/** The coded error an add past the cap rejects with. */
export function toolFavoriteCapError(): Error {
  const error = new Error(`Maximum of ${MAX_TOOL_FAVORITES} favorites reached`);
  (error as Error & { code: string; limit: number }).code = 'MAX_FAVORITES_EXCEEDED';
  (error as Error & { code: string; limit: number }).limit = MAX_TOOL_FAVORITES;
  return error;
}
