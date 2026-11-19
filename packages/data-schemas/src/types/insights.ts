import type { TInsightsAgent, TInsightsParams, TInsightsResponse } from 'librechat-data-provider';

/** What an insights report covers: its range, filters and the agents the viewer may see. */
export type InsightsOptions = TInsightsParams & {
  tenantId?: string;
  agents?: TInsightsAgent[];
};

export type InsightsResult = TInsightsResponse;
