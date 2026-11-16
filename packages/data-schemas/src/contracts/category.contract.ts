/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factories that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `CategoriesStore` (`~/ports/categories`, the fixed prompt categories) and
 * `AgentCategoryStore` (`~/ports/agentCategory`) contracts: ordering, agent counts per category,
 * creation and the default-category seeding. Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import type { ContractHarness } from './harness';
import { useContractHarness } from './support';

const DEFAULT_AGENT_CATEGORIES = ['general', 'hr', 'rd', 'finance', 'it', 'sales', 'aftersales'];

export function describeCategoriesContract(harness: ContractHarness): void {
  describe(`CategoriesStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    it('getCategories returns the fixed categories in display order', async () => {
      const categories = await harness.createStores().categories.getCategories();
      expect(categories.map((category) => category.value)).toEqual([
        'idea',
        'travel',
        'teach_or_explain',
        'write',
        'shop',
        'code',
        'misc',
        'roleplay',
        'finance',
      ]);
      expect(categories[0]).toEqual({ label: 'com_ui_idea', value: 'idea' });
    });

    it('getCategories hands out a copy each time', async () => {
      const { categories } = harness.createStores();
      const first = await categories.getCategories();
      first.pop();
      expect(await categories.getCategories()).toHaveLength(9);
    });
  });
}

export function describeAgentCategoryContract(harness: ContractHarness): void {
  describe(`AgentCategoryStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const category = (value: string, overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      value,
      label: `label ${value}`,
      description: '',
      order: 0,
      isActive: true,
      custom: false,
      ...overrides,
    });

    describe('getActiveCategories', () => {
      it('returns the active categories by order, then label', async () => {
        await harness.seedRaw('agentcategories', [
          category('c', { order: 1, label: 'B' }),
          category('a', { order: 2, label: 'A' }),
          category('b', { order: 1, label: 'A' }),
          category('hidden', { order: 0, isActive: false }),
        ]);
        const active = await harness.createStores().agentCategories.getActiveCategories();
        expect(active.map((item) => item.value)).toEqual(['b', 'c', 'a']);
      });
    });

    describe('getAllCategories', () => {
      it('returns active and inactive categories by order, then label', async () => {
        await harness.seedRaw('agentcategories', [
          category('a', { order: 2 }),
          category('hidden', { order: 0, isActive: false }),
          category('b', { order: 1 }),
        ]);
        const all = await harness.createStores().agentCategories.getAllCategories();
        expect(all.map((item) => item.value)).toEqual(['hidden', 'b', 'a']);
      });
    });

    describe('getCategoriesWithCounts', () => {
      it('counts the agents filed under each active category, zero when none', async () => {
        await harness.seedRaw('agentcategories', [
          category('general', { order: 0 }),
          category('hr', { order: 1 }),
          category('it', { order: 2, isActive: false }),
        ]);
        const agent = (agentCategory: string | null | undefined) => ({
          _id: harness.ids.generate(),
          id: `agent_${harness.ids.generate()}`,
          name: 'Agent',
          provider: 'openAI',
          model: 'gpt',
          author: harness.ids.generate(),
          ...(agentCategory === undefined ? {} : { category: agentCategory }),
        });
        await harness.seedRaw('agents', [
          agent('general'),
          agent('general'),
          agent('it'),
          agent(null),
          agent(undefined),
        ]);
        const counted = await harness.createStores().agentCategories.getCategoriesWithCounts();
        expect(counted.map(({ value, agentCount }) => ({ value, agentCount }))).toEqual([
          { value: 'general', agentCount: 2 },
          { value: 'hr', agentCount: 0 },
        ]);
        expect(counted[0]).toMatchObject({ label: 'label general', isActive: true });
      });
    });

    describe('createCategory', () => {
      it('creates a category with defaults, normalized as declared', async () => {
        const created = await harness.createStores().agentCategories.createCategory({
          value: '  Custom ',
          label: ' Custom label ',
        });
        expect(created).toMatchObject({
          value: 'custom',
          label: 'Custom label',
          description: '',
          order: 0,
          isActive: true,
          custom: false,
        });
        expect(harness.ids.isValid(created._id)).toBe(true);
        const [stored] = await harness.readRaw('agentcategories');
        expect(stored).toMatchObject({ value: 'custom', label: 'Custom label' });
        expect(stored.createdAt).toBeInstanceOf(Date);
      });

      it('rejects a value that already exists as a duplicate key', async () => {
        const { agentCategories } = harness.createStores();
        await agentCategories.createCategory({ value: 'dup', label: 'One' });
        const failure = await agentCategories
          .createCategory({ value: 'dup', label: 'Two' })
          .catch((error: unknown) => error);
        expect(harness.errors.isDuplicateKey(failure)).toBe(true);
      });

      it('rejects a category without its required fields', async () => {
        await expect(
          harness.createStores().agentCategories.createCategory({ value: 'nolabel' }),
        ).rejects.toThrow();
        expect(await harness.readRaw('agentcategories')).toEqual([]);
      });
    });

    describe('ensureDefaultCategories', () => {
      it('creates every missing default category and reports a change', async () => {
        const { agentCategories } = harness.createStores();
        expect(await agentCategories.ensureDefaultCategories()).toBe(true);
        const all = await agentCategories.getAllCategories();
        expect(all.map((item) => item.value)).toEqual(DEFAULT_AGENT_CATEGORIES);
        expect(all[0]).toMatchObject({
          label: 'com_agents_category_general',
          description: 'com_agents_category_general_description',
          isActive: true,
          custom: false,
        });
      });

      it('reports no change once the defaults exist', async () => {
        const { agentCategories } = harness.createStores();
        await agentCategories.ensureDefaultCategories();
        expect(await agentCategories.ensureDefaultCategories()).toBe(false);
        expect(await harness.readRaw('agentcategories')).toHaveLength(7);
      });

      it('moves non-custom defaults onto localization keys (a change), leaving custom ones', async () => {
        await harness.seedRaw('agentcategories', [
          category('general', { label: 'General', description: 'Plain text' }),
          category('hr', { label: 'People', description: 'Custom', custom: true, order: 1 }),
          category('rd', { label: 'com_custom_rd', order: 2 }),
          ...['finance', 'it', 'sales', 'aftersales'].map((value, index) =>
            category(value, { label: `com_agents_category_${value}`, order: index + 3 }),
          ),
        ]);
        const { agentCategories } = harness.createStores();
        expect(await agentCategories.ensureDefaultCategories()).toBe(true);
        const byValue = new Map(
          (await agentCategories.getAllCategories()).map((item) => [item.value, item]),
        );
        expect(byValue.get('general')).toMatchObject({
          label: 'com_agents_category_general',
          description: 'com_agents_category_general_description',
        });
        expect(byValue.get('hr')).toMatchObject({ label: 'People', custom: true });
        expect(byValue.get('rd')).toMatchObject({ label: 'com_custom_rd' });
        expect(byValue.size).toBe(7);
      });
    });
  });
}
