import type { Model } from 'mongoose';
import type { IAgentCategory } from '~/types';
import { planDefaultCategories, withAgentCounts } from './agentCategoryRules';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';

export function createAgentCategoryMethods(mongoose: typeof import('mongoose')): {
  getActiveCategories: () => Promise<IAgentCategory[]>;
  getCategoriesWithCounts: () => Promise<(IAgentCategory & { agentCount: number })[]>;
  createCategory: (categoryData: Partial<IAgentCategory>) => Promise<IAgentCategory>;
  getAllCategories: () => Promise<IAgentCategory[]>;
  ensureDefaultCategories: () => Promise<boolean>;
} {
  /**
   * Get all active categories sorted by order
   * @returns Array of active categories
   */
  async function getActiveCategories(): Promise<IAgentCategory[]> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.find({ isActive: true })
      .sort({ order: 1, label: 1 })
      .lean<IAgentCategory[]>();
  }

  /**
   * Get categories with agent counts
   * @returns Categories with agent counts
   */
  async function getCategoriesWithCounts(): Promise<(IAgentCategory & { agentCount: number })[]> {
    const Agent = mongoose.models.Agent;

    const [categoryCounts, categories] = await Promise.all([
      Agent.aggregate([
        { $match: { category: { $exists: true, $ne: null } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
      getActiveCategories(),
    ]);

    return withAgentCounts(categories, categoryCounts);
  }

  /**
   * Create a new category
   * @param categoryData - The category data to create
   * @returns The created category
   */
  async function createCategory(categoryData: Partial<IAgentCategory>): Promise<IAgentCategory> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    const category = await AgentCategory.create(categoryData);
    return category.toObject() as IAgentCategory;
  }

  /**
   * Get all categories (active and inactive)
   * @returns Array of all categories
   */
  async function getAllCategories(): Promise<IAgentCategory[]> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.find({}).sort({ order: 1, label: 1 }).lean<IAgentCategory[]>();
  }

  /**
   * Ensure default categories exist and update them if they don't have localization keys
   * @returns Promise<boolean> - true if categories were created/updated, false if no changes
   */
  async function ensureDefaultCategories(): Promise<boolean> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;

    const existingCategories = await getAllCategories();
    const { creates, updates } = planDefaultCategories(existingCategories);

    let created = 0;
    for (const category of creates) {
      await createCategory(category);
      created++;
    }

    if (updates.length > 0) {
      await tenantSafeBulkWrite(AgentCategory, updates, { ordered: false });
    }

    return updates.length > 0 || created > 0;
  }

  return {
    getActiveCategories,
    getCategoriesWithCounts,
    createCategory,
    getAllCategories,
    ensureDefaultCategories,
  };
}

export type AgentCategoryMethods = ReturnType<typeof createAgentCategoryMethods>;
