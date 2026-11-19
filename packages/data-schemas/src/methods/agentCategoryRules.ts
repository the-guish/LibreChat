/**
 * The agent category store's database-neutral rules (`AgentCategoryStore`,
 * `~/ports/agentCategory`), shared by every backend: the MongoDB methods (`./agentCategory`) and
 * the PostgreSQL store (`adapters/postgres/stores/agentCategory.ts`). Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import type { IAgentCategory } from '~/types';

/** The default categories, in their order. */
const DEFAULT_AGENT_CATEGORIES = [
  {
    value: 'general',
    label: 'com_agents_category_general',
    description: 'com_agents_category_general_description',
    order: 0,
  },
  {
    value: 'hr',
    label: 'com_agents_category_hr',
    description: 'com_agents_category_hr_description',
    order: 1,
  },
  {
    value: 'rd',
    label: 'com_agents_category_rd',
    description: 'com_agents_category_rd_description',
    order: 2,
  },
  {
    value: 'finance',
    label: 'com_agents_category_finance',
    description: 'com_agents_category_finance_description',
    order: 3,
  },
  {
    value: 'it',
    label: 'com_agents_category_it',
    description: 'com_agents_category_it_description',
    order: 4,
  },
  {
    value: 'sales',
    label: 'com_agents_category_sales',
    description: 'com_agents_category_sales_description',
    order: 5,
  },
  {
    value: 'aftersales',
    label: 'com_agents_category_aftersales',
    description: 'com_agents_category_aftersales_description',
    order: 6,
  },
];

/** One relabel of a non-custom default, as a bulk `updateOne` in the store query language. */
export interface DefaultCategoryUpdate {
  updateOne: {
    filter: { value: string; custom: { $ne: true } };
    update: { $set: { label: string; description: string } };
  };
}

/**
 * What `ensureDefaultCategories` writes, given every stored category: the missing defaults to
 * create (active, not custom), in order, and the non-custom defaults whose label is not a
 * localization key yet to move onto theirs.
 */
export function planDefaultCategories(existingCategories: IAgentCategory[]): {
  creates: Array<Partial<IAgentCategory>>;
  updates: DefaultCategoryUpdate[];
} {
  const existingCategoryMap = new Map(existingCategories.map((cat) => [cat.value, cat]));

  const relabels: Array<{ value: string; label: string; description: string }> = [];
  const creates: Array<Partial<IAgentCategory>> = [];

  for (const defaultCategory of DEFAULT_AGENT_CATEGORIES) {
    const existingCategory = existingCategoryMap.get(defaultCategory.value);

    if (existingCategory) {
      const isNotCustom = !existingCategory.custom;
      const needsLocalization = !existingCategory.label.startsWith('com_');

      if (isNotCustom && needsLocalization) {
        relabels.push({
          value: defaultCategory.value,
          label: defaultCategory.label,
          description: defaultCategory.description,
        });
      }
    } else {
      creates.push({
        ...defaultCategory,
        isActive: true,
        custom: false,
      });
    }
  }

  const updates = relabels.map((update) => ({
    updateOne: {
      filter: { value: update.value, custom: { $ne: true as const } },
      update: {
        $set: {
          label: update.label,
          description: update.description,
        },
      },
    },
  }));

  return { creates, updates };
}

/** The categories with the number of agents filed under each `value` (`_id`: the category). */
export function withAgentCounts(
  categories: IAgentCategory[],
  categoryCounts: ReadonlyArray<{ _id: unknown; count: number }>,
): (IAgentCategory & { agentCount: number })[] {
  const countMap = new Map(categoryCounts.map((c) => [c._id, c.count]));

  return categories.map((category) => ({
    ...category,
    agentCount: countMap.get(category.value) || (0 as number),
  })) as (IAgentCategory & { agentCount: number })[];
}
