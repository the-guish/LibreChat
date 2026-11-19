/**
 * MongoDB only: the collection helpers moved to the MongoDB adapter in `@librechat/data-schemas`
 * and are re-exported here for the MongoDB-only `config/migrate-*-permissions` scripts.
 */
export { ensureCollectionExists, ensureRequiredCollectionsExist } from '@librechat/data-schemas';
