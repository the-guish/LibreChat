/**
 * Insights store port: the usage report of agent conversations (totals, daily series, top
 * agents and users, recent and churned activity) over a date range. Nothing here may import
 * `mongoose`. Signatures are copied verbatim from `InsightsMethods` (`~/methods/insights`);
 * `insights.spec.ts` fails the typecheck if the two drift.
 *
 * The report reads conversations, messages and users. It counts only the agents in `agentIds`
 * (a conversation is attributed to the agent it started with), never temporary conversations
 * or subagent threads, and only the tenant's records when `tenantId` is given (without one,
 * only records outside any tenant). The range is capped at the longest one the report allows.
 */
import type { InsightsOptions, InsightsResult } from '~/types';
import { listPortMethods } from './common';

export interface InsightsStore {
  /** The report for the options; with none, the default range over no agents. */
  getInsights(options?: InsightsOptions): Promise<InsightsResult>;
}

/** Every method of {@link InsightsStore}, for adapters and conformance checks. */
export const INSIGHTS_STORE_METHODS: ReadonlyArray<keyof InsightsStore> =
  listPortMethods<InsightsStore>({
    getInsights: true,
  });
