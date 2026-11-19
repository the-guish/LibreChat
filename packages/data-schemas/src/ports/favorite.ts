/**
 * Tool favorite store port: the tools and other items a user marked as favorites. Nothing here
 * may import `mongoose`. Signatures are copied verbatim from `ToolFavoriteMethods`
 * (`~/methods/favorite`); `favorite.spec.ts` fails the typecheck if the two drift.
 */
import type {
  AddToolFavoriteResult,
  IToolFavoriteLean,
  RemoveToolFavoriteResult,
  ToolFavoriteParams,
} from '~/types';
import { listPortMethods } from './common';

export interface ToolFavoriteStore {
  /** The user's favorites, oldest first. */
  getToolFavorites(userId: string): Promise<IToolFavoriteLean[]>;
  /**
   * Idempotent add: `added: false` when the favorite already exists. Throws an error with code
   * `MAX_FAVORITES_EXCEEDED` once the user holds `MAX_TOOL_FAVORITES`; the cap may overshoot by
   * one or two under concurrency.
   */
  addToolFavorite(params: ToolFavoriteParams): Promise<AddToolFavoriteResult>;
  /** `removed: false` when there was no such favorite. */
  removeToolFavorite(params: ToolFavoriteParams): Promise<RemoveToolFavoriteResult>;
  /** Account erasure: removes every favorite of the user and returns how many there were. */
  deleteUserToolFavorites(userId: string): Promise<number>;
}

/** Every method of {@link ToolFavoriteStore}, for adapters and conformance checks. */
export const TOOL_FAVORITE_STORE_METHODS: ReadonlyArray<keyof ToolFavoriteStore> =
  listPortMethods<ToolFavoriteStore>({
    getToolFavorites: true,
    addToolFavorite: true,
    removeToolFavorite: true,
    deleteUserToolFavorites: true,
  });
