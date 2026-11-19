/**
 * Agent category store port: the categories agents are filed under. Nothing here may import
 * `mongoose`. Signatures are copied verbatim from `AgentCategoryMethods`
 * (`~/methods/agentCategory`); `agentCategory.spec.ts` fails the typecheck if the two drift. The
 * MongoDB adapter also reads the agent collection, for the counts.
 *
 * Known leak kept for now so callers stay unchanged: `IAgentCategory` extends mongoose's
 * `Document`.
 */
import type { IAgentCategory } from '~/types';
import { listPortMethods } from './common';

export interface AgentCategoryStore {
  /** The active categories, by `order` then `label`. */
  getActiveCategories(): Promise<IAgentCategory[]>;
  /** The active categories, each with the number of agents filed under its `value`. */
  getCategoriesWithCounts(): Promise<(IAgentCategory & { agentCount: number })[]>;
  createCategory(categoryData: Partial<IAgentCategory>): Promise<IAgentCategory>;
  /** Every category, active or not, by `order` then `label`. */
  getAllCategories(): Promise<IAgentCategory[]>;
  /**
   * Creates the default categories that are missing and moves non-custom defaults whose label is
   * not yet a localization key onto one. `true` when anything changed.
   */
  ensureDefaultCategories(): Promise<boolean>;
}

/** Every method of {@link AgentCategoryStore}, for adapters and conformance checks. */
export const AGENT_CATEGORY_STORE_METHODS: ReadonlyArray<keyof AgentCategoryStore> =
  listPortMethods<AgentCategoryStore>({
    getActiveCategories: true,
    getCategoriesWithCounts: true,
    createCategory: true,
    getAllCategories: true,
    ensureDefaultCategories: true,
  });
