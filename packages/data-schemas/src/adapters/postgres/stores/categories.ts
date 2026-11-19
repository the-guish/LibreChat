/**
 * The PostgreSQL `CategoriesStore` (`~/ports/categories`): the fixed prompt categories, which no
 * backend stores. It is the MongoDB module itself (`createCategoriesMethods`), which reads no
 * collection and never touches the mongoose instance it is given by convention. Must not import
 * `mongoose`, `mongodb` or `bson`.
 */
import type { CategoriesStore } from '~/ports/categories';
import { createCategoriesMethods } from '~/methods/categories';

/** `createCategoriesMethods` takes the mongoose instance only by convention; it never reads it. */
type CategoriesMongooseParameter = Parameters<typeof createCategoriesMethods>[0];

export function createPostgresCategoriesStore(): CategoriesStore {
  const store: CategoriesStore = createCategoriesMethods(
    undefined as unknown as CategoriesMongooseParameter,
  );
  return store;
}
