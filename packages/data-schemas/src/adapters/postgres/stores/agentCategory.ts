/**
 * The PostgreSQL `AgentCategoryStore` (`~/ports/agentCategory`) on the `agentcategories` table,
 * through the collection primitive, with the default categories plan of
 * `~/methods/agentCategoryRules`, plus one hand-written statement: the agent counts per category
 * (`GROUP BY` over `agents`, PHASE4.md §4 "Group, count, facet"), restricted to the active tenant
 * as the mongoose plugin restricts the MongoDB aggregation. Must not import `mongoose`, `mongodb`
 * or `bson`.
 */
import { sql } from 'kysely';
import type { AgentCategoryStore } from '~/ports/agentCategory';
import type { PostgresStoreContext } from './context';
import type { IAgentCategory } from '~/types';
import { planDefaultCategories, withAgentCounts } from '~/methods/agentCategoryRules';
import { runStoreSql, storeWhere } from './context';

type CategoryRecord = IAgentCategory & Record<string, unknown>;

/** The active and inactive categories' order: `order`, then `label`. */
const CATEGORY_ORDER = { order: 1, label: 1 } as const;

export function createPostgresAgentCategoryStore(
  context: PostgresStoreContext,
): AgentCategoryStore {
  const categories = () => context.collections().collection<CategoryRecord>('agentcategories');

  /** The number of agents per category (`category` set and not `null`). */
  async function countAgentsByCategory(): Promise<Array<{ _id: unknown; count: number }>> {
    const where = storeWhere(context, 'agents', { category: { $exists: true, $ne: null } });
    const { rows } = await runStoreSql<{ _id: string; count: string }>(
      context,
      sql`SELECT t."category" AS "_id", count(*) AS "count" FROM "agents" AS t WHERE ${where} GROUP BY t."category"`,
    );
    return rows.map((row) => ({ _id: row._id, count: Number(row.count) }));
  }

  const store: AgentCategoryStore = {
    async getActiveCategories() {
      return categories().find({ isActive: true }, { sort: CATEGORY_ORDER });
    },

    async getCategoriesWithCounts() {
      const [categoryCounts, active] = await Promise.all([
        countAgentsByCategory(),
        store.getActiveCategories(),
      ]);
      return withAgentCounts(active, categoryCounts);
    },

    async createCategory(categoryData) {
      return categories().insertOne(categoryData as Record<string, unknown>);
    },

    async getAllCategories() {
      return categories().find({}, { sort: CATEGORY_ORDER });
    },

    async ensureDefaultCategories() {
      const { creates, updates } = planDefaultCategories(await store.getAllCategories());
      let created = 0;
      for (const category of creates) {
        await store.createCategory(category);
        created++;
      }
      if (updates.length > 0) {
        /** Unordered, as MongoDB's: each relabel runs whatever the others do. */
        await categories().bulk(updates, { ordered: false });
      }
      return updates.length > 0 || created > 0;
    },
  };
  return store;
}
