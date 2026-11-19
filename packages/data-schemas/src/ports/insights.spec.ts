import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { InsightsMethods } from '~/methods/insights';
import type { InsightsStore } from './insights';
import { createInsightsMethods } from '~/methods/insights';
import { INSIGHTS_STORE_METHODS } from './insights';

/**
 * Insights methods left out of the port, each with the reason: none. `getInsights` takes plain
 * report options; the aggregation pipelines it runs stay inside the MongoDB adapter.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<InsightsStore, InsightsMethods>>,
  Assert<EveryMethodPlaced<InsightsStore, InsightsMethods, Excluded>>,
  Assert<ExclusionsHold<InsightsStore, Excluded>>,
];

describe('InsightsStore port', () => {
  const methods = createInsightsMethods(mongoose);

  it('matches the MongoDB insights methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(INSIGHTS_STORE_METHODS).size).toBe(INSIGHTS_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...INSIGHTS_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB insights methods', () => {
    const store: InsightsStore = methods;
    for (const name of INSIGHTS_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
