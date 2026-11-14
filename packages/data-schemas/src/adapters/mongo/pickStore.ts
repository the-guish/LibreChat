/**
 * `pickStore` is database-neutral and lives with the composition root (`~/compose/stores`); the
 * MongoDB adapters keep importing it from here.
 */
export { pickStore } from '~/compose/stores';
