import { describeAgentCategoryContract, describeCategoriesContract } from './category.contract';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/**
 * The `CategoriesStore` and `AgentCategoryStore` contracts on PostgreSQL, on a suite database
 * copied from the migrated template.
 */
describePostgres('CategoriesStore and AgentCategoryStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  const engine = {
    connect: async () => database.uri,
    release: async () => undefined,
  };
  describeCategoriesContract(createPostgresContractHarness(engine));
  describeAgentCategoryContract(createPostgresContractHarness(engine));
});
