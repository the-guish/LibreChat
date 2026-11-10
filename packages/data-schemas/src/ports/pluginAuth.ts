/**
 * Plugin auth store port: the credentials users enter for tools and MCP servers, one value per
 * user, plugin and auth field. Nothing here may import `mongoose`. Signatures are those of
 * `PluginAuthMethods` (`~/methods/pluginAuth`) with delete results stated as `DeleteCount`;
 * `pluginAuth.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them. Values
 * arrive and leave encrypted by the caller; a store keeps them as given. Failures are thrown as
 * errors whose message names the operation.
 *
 * Known leak kept for now so callers stay unchanged: `IPluginAuth` extends mongoose's
 * `Document`.
 */
import type {
  IPluginAuth,
  FindPluginAuthParams,
  UpdatePluginAuthParams,
  DeletePluginAuthParams,
  FindPluginAuthsByKeysParams,
} from '~/types';
import type { DeleteCount } from './common';
import { listPortMethods } from './common';

export interface PluginAuthStore {
  /** The user's value for `authField`, narrowed to `pluginKey` when given, or `null`. */
  findOnePluginAuth(params: FindPluginAuthParams): Promise<IPluginAuth | null>;
  /** The user's values for any of the plugins; none for an empty list. */
  findPluginAuthsByKeys(params: FindPluginAuthsByKeysParams): Promise<IPluginAuth[]>;
  /** Creates or replaces the user's value for the plugin's auth field, in one atomic write. */
  updatePluginAuth(params: UpdatePluginAuthParams): Promise<IPluginAuth>;
  /**
   * Deletes the user's value for `authField`, or with `all` every value of the user (of
   * `pluginKey`, when given). Without `all`, `authField` is required.
   */
  deletePluginAuth(params: DeletePluginAuthParams): Promise<DeleteCount>;
  /** Deletes every value of the user. */
  deleteAllUserPluginAuths(userId: string): Promise<DeleteCount>;
}

/** Every method of {@link PluginAuthStore}, for adapters and conformance checks. */
export const PLUGIN_AUTH_STORE_METHODS: ReadonlyArray<keyof PluginAuthStore> =
  listPortMethods<PluginAuthStore>({
    findOnePluginAuth: true,
    findPluginAuthsByKeys: true,
    updatePluginAuth: true,
    deletePluginAuth: true,
    deleteAllUserPluginAuths: true,
  });
