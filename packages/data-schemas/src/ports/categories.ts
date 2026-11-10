/**
 * Categories store port: the categories offered for prompts. Nothing here may import `mongoose`.
 * Signatures are copied verbatim from `CategoriesMethods` (`~/methods/categories`);
 * `categories.spec.ts` fails the typecheck if the two drift. The MongoDB methods serve a fixed
 * list and read no collection.
 */
import type { CategoryOption } from '~/types';
import { listPortMethods } from './common';

export interface CategoriesStore {
  /** Every category, in display order; an empty list rather than an error. */
  getCategories(): Promise<CategoryOption[]>;
}

/** Every method of {@link CategoriesStore}, for adapters and conformance checks. */
export const CATEGORIES_STORE_METHODS: ReadonlyArray<keyof CategoriesStore> =
  listPortMethods<CategoriesStore>({
    getCategories: true,
  });
