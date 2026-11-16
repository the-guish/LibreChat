import type { Pool } from 'pg';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { createQueryTranslator } from './index';

/**
 * `EXPLAIN` specs of the translator (docs/postgres-port/PHASE4.md §2.5, R3): the main reads, as
 * the stores will issue them, can use the index the generator wrote for them. The migrated schema
 * is empty here, so the planner's choice between indexes is arbitrary: each read is explained in
 * a transaction (rolled back) with sequential scans disabled and the other indexes of the
 * intended index's table dropped, so the plan uses the intended index exactly when the
 * translated condition (and order, where `ordered`) can use it.
 */

const translator = createQueryTranslator(SCHEMA_DESCRIPTOR);
const ID = (n: number) => n.toString(16).padStart(24, '0');

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

interface ExplainCase {
  name: string;
  collection: string;
  filter: Record<string, unknown>;
  sort?: Record<string, unknown>;
  limit?: number;
  /** The index the read must use. */
  index: string;
  /** The index also serves the order (no `Sort` node). */
  ordered?: boolean;
}

const NOW = new Date('2025-06-01T00:00:00.000Z');

const CASES: ExplainCase[] = [
  {
    name: 'conversation list (user, not archived, newest first)',
    collection: 'conversations',
    filter: {
      user: 'u1',
      $or: [{ isArchived: false }, { isArchived: { $exists: false } }],
    },
    sort: { updatedAt: -1, _id: -1 },
    limit: 25,
    index: 'conversations__user__updatedAt_desc___id_desc',
    ordered: true,
  },
  {
    name: 'message page (conversation, user, oldest first)',
    collection: 'messages',
    filter: { conversationId: 'c1', user: 'u1' },
    sort: { createdAt: 1, _id: 1 },
    limit: 50,
    index: 'messages__conversationId__user__createdAt___id',
    ordered: true,
  },
  {
    name: 'ACL lookup (principal and resource)',
    collection: 'aclentries',
    filter: {
      principalId: ID(1),
      principalType: 'user',
      resourceType: 'agent',
      resourceId: ID(2),
    },
    index: 'aclentries__principalId__principalType__resourceType___592f0aaf',
  },
  {
    name: 'queue claim (lane, queued and available, by priority)',
    collection: 'agentqueuedturns',
    filter: {
      tenantId: 't1',
      user: ID(3),
      conversationId: 'c1',
      status: 'queued',
      availableAt: { $lte: NOW },
    },
    sort: { priority: -1, availableAt: 1, sequence: 1 },
    limit: 1,
    index: 'agentqueuedturns__tenantId__user__conversationId__stat_8c56543b',
    ordered: true,
  },
  {
    name: 'trigger-delivery envelope lookup (hinted json paths)',
    collection: 'agenttriggerdeliveries',
    filter: {
      user: ID(3),
      'envelope.event.source.type': 'background_tool_result',
      'envelope.event.source.id': 'run_1',
      'envelope.target.conversationId': 'c1',
    },
    index: 'agenttriggerdeliveries__user__envelope_event_source_ty_9f8eb336',
  },
  {
    name: 'token prefix search (element table)',
    collection: 'users',
    filter: { nameTokens: /^al/ },
    index: 'users__nameTokens__value',
  },
  {
    name: 'favorite holders (child table path)',
    collection: 'users',
    filter: { 'favorites.agentId': 'agent_1' },
    index: 'users__favorites__agentId',
  },
  {
    name: 'agents by edge target (json GIN, lax jsonpath prefilter)',
    collection: 'agents',
    filter: { 'edges.to': { $in: ['agent_a', 'agent_b'] } },
    index: 'agents__edges__gin',
  },
  {
    name: 'groups by member (scalar array GIN)',
    collection: 'groups',
    filter: { memberIds: 'm1' },
    index: 'groups__memberIds__gin',
  },
];

describePostgres('query translator: EXPLAIN of the main reads', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let pool: Pool;

  beforeAll(() => {
    pool = database.pool();
  });

  async function explain(text: string, values: unknown[], index: string): Promise<PlanNode> {
    const table = SCHEMA_DESCRIPTOR.tables.find((entry) =>
      entry.indexes.some((candidate) => candidate.name === index),
    );
    expect(table).toBeDefined();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      for (const other of table!.indexes) {
        if (other.name !== index) {
          await client.query(`DROP INDEX ${JSON.stringify(other.name)}`);
        }
      }
      const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values);
      await client.query('ROLLBACK');
      /** The backend's pool reads `json` as text. */
      const output = rows[0]['QUERY PLAN'] as string | Array<{ Plan: PlanNode }>;
      return (typeof output === 'string' ? JSON.parse(output) : output)[0].Plan;
    } finally {
      client.release();
    }
  }

  it.each(CASES)(
    '$name uses $index',
    async ({ collection, filter, sort, limit, index, ordered }) => {
      const read = translator.find(collection, { filter, sort, limit, projection: '_id' });
      const plan = await explain(read.text, read.values, index);
      const all = nodes(plan);
      expect(all.map((node) => node['Index Name']).filter(Boolean)).toContain(index);
      expect(all.map((node) => node['Node Type'])).not.toContain('Seq Scan');
      if (ordered) {
        expect(all.map((node) => node['Node Type'])).not.toContain('Sort');
      }
    },
  );
});
