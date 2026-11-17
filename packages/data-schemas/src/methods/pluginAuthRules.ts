/**
 * The plugin auth store's database-neutral rules (`PluginAuthStore`, `~/ports/pluginAuth`), shared
 * by every backend: the MongoDB methods (`./pluginAuth`) and the PostgreSQL store
 * (`adapters/postgres/stores/pluginAuth.ts`). The lookup and delete filters, stated in the store
 * query language. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { DeletePluginAuthParams, FindPluginAuthParams } from '~/types';

/** The filter of `findOnePluginAuth`: the user's field, narrowed to the plugin when given. */
export function pluginAuthFilter({
  userId,
  authField,
  pluginKey,
}: FindPluginAuthParams): Record<string, unknown> {
  return {
    userId,
    authField,
    ...(pluginKey && { pluginKey }),
  };
}

/**
 * What `deletePluginAuth` deletes: with `all`, every value of the user (narrowed to the plugin
 * when given); otherwise one value of the user's field, whichever plugin holds it (`pluginKey`
 * is not part of that filter). Throws without `all` and without `authField`.
 */
export function pluginAuthDeletion({
  userId,
  authField,
  pluginKey,
  all = false,
}: DeletePluginAuthParams): { many: boolean; filter: Record<string, unknown> } {
  if (all) {
    const filter: DeletePluginAuthParams = { userId };
    if (pluginKey) {
      filter.pluginKey = pluginKey;
    }
    return { many: true, filter: { ...filter } };
  }

  if (!authField) {
    throw new Error('authField is required when all is false');
  }

  return { many: false, filter: { userId, authField } };
}
