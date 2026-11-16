/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ActionStore` contract (`~/ports/action`), ported from `methods/action.spec.ts`: domain
 * criteria (one or several values, AND, fail-closed on unknown criteria), the sensitive-metadata
 * redaction, the upserting update and the deletes. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import type { ContractHarness } from './harness';
import type { ActionQuery } from '~/types';
import { idOf, useContractHarness } from './support';

export function describeActionContract(harness: ContractHarness): void {
  describe(`ActionStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userA = harness.ids.generate();
    const userB = harness.ids.generate();
    const action = (overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      user: userA,
      action_id: 'act-1',
      type: 'action_prototype',
      metadata: { domain: 'example.com', auth: { type: 'none' } },
      ...overrides,
    });

    describe('getActions', () => {
      it('finds by a single action id', async () => {
        await harness.seedRaw('actions', [
          action({ action_id: 'act-1', agent_id: 'agent-1' }),
          action({ action_id: 'act-2', agent_id: 'agent-1' }),
        ]);
        const found = await harness.createStores().actions.getActions({ actionId: 'act-1' }, true);
        expect(found.map((item) => item.action_id)).toEqual(['act-1']);
      });

      it('finds by any of several ids', async () => {
        await harness.seedRaw('actions', [
          action({ action_id: 'act-1' }),
          action({ action_id: 'act-2' }),
          action({ action_id: 'act-3' }),
        ]);
        const found = await harness
          .createStores()
          .actions.getActions({ actionId: ['act-1', 'act-3'] }, true);
        expect(found.map((item) => item.action_id).sort()).toEqual(['act-1', 'act-3']);
      });

      it('combines criteria with AND (agent, assistant, user)', async () => {
        await harness.seedRaw('actions', [
          action({ action_id: 'act-1', agent_id: 'agent-1' }),
          action({ action_id: 'act-1', agent_id: 'agent-2' }),
          action({ action_id: 'act-1', assistant_id: 'asst-1', user: userB }),
        ]);
        const { actions } = harness.createStores();
        const byAgent = await actions.getActions({ actionId: 'act-1', agentId: 'agent-2' }, true);
        expect(byAgent).toHaveLength(1);
        expect(byAgent[0].agent_id).toBe('agent-2');
        const byAssistant = await actions.getActions({ assistantId: 'asst-1', user: userB }, true);
        expect(byAssistant).toHaveLength(1);
        expect(idOf(harness, byAssistant[0].user)).toBe(userB);
        expect(await actions.getActions({ assistantId: 'asst-1', user: userA }, true)).toEqual([]);
      });

      it('still omits a recognized criterion the caller left undefined', async () => {
        await harness.seedRaw('actions', [
          action({ action_id: 'act-1', agent_id: 'agent-1' }),
          action({ action_id: 'act-2', agent_id: 'agent-2' }),
        ]);
        const found = await harness
          .createStores()
          .actions.getActions({ actionId: 'act-1', agentId: undefined }, true);
        expect(found.map((item) => item.action_id)).toEqual(['act-1']);
      });

      it('matches every action with no criteria', async () => {
        await harness.seedRaw('actions', [action(), action({ action_id: 'act-2' })]);
        expect(await harness.createStores().actions.getActions({}, true)).toHaveLength(2);
      });

      it('rejects an unrecognized criterion instead of matching every action', async () => {
        await harness.seedRaw('actions', [action()]);
        await expect(
          harness
            .createStores()
            .actions.getActions({ action_id: 'act-1' } as unknown as ActionQuery, true),
        ).rejects.toThrow("Unknown query criterion: 'action_id'");
      });

      it('rejects a criterion that is not a scalar or a list of scalars', async () => {
        await expect(
          harness
            .createStores()
            .actions.getActions({ agentId: { $ne: null } } as unknown as ActionQuery, true),
        ).rejects.toThrow("Invalid value for query criterion 'agentId'");
      });

      it('removes the API key and OAuth client credentials unless asked for them', async () => {
        await harness.seedRaw('actions', [
          action({
            metadata: {
              domain: 'example.com',
              api_key: 'secret-key',
              oauth_client_id: 'client-id',
              oauth_client_secret: 'client-secret',
              raw_spec: 'openapi: 3.0.0',
            },
          }),
        ]);
        const { actions } = harness.createStores();
        const [redacted] = await actions.getActions({ actionId: 'act-1' });
        expect(redacted.metadata).toEqual({ domain: 'example.com', raw_spec: 'openapi: 3.0.0' });
        const [full] = await actions.getActions({ actionId: 'act-1' }, true);
        expect(full.metadata).toMatchObject({
          api_key: 'secret-key',
          oauth_client_id: 'client-id',
          oauth_client_secret: 'client-secret',
        });
        const [stored] = await harness.readRaw('actions');
        expect(stored.metadata).toMatchObject({ api_key: 'secret-key' });
      });
    });

    describe('updateAction', () => {
      it('sets the given fields on the matching action, keeping the others', async () => {
        const seeded = action({ agent_id: 'agent-1', settings: { a: 1 } });
        await harness.seedRaw('actions', [seeded]);
        const updated = await harness.createStores().actions.updateAction(
          { actionId: 'act-1', agentId: 'agent-1' },
          {
            metadata: {
              domain: 'new.example.com',
              auth: { type: 'none', token_exchange_method: null },
            },
          },
        );
        expect(idOf(harness, updated?._id)).toBe(seeded._id);
        expect(updated).toMatchObject({
          action_id: 'act-1',
          agent_id: 'agent-1',
          settings: { a: 1 },
          metadata: { domain: 'new.example.com' },
        });
        const records = await harness.readRaw('actions');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ metadata: { domain: 'new.example.com' } });
      });

      it('creates the action from the criteria and the fields when none matches', async () => {
        const created = await harness.createStores().actions.updateAction(
          { actionId: 'new-act', agentId: 'agent-9', user: userB },
          {
            metadata: {
              domain: 'created.example.com',
              auth: { type: 'none', token_exchange_method: null },
            },
          },
        );
        expect(created).toMatchObject({
          action_id: 'new-act',
          agent_id: 'agent-9',
          type: 'action_prototype',
          metadata: { domain: 'created.example.com' },
        });
        expect(idOf(harness, created?.user)).toBe(userB);
        const [stored] = await harness.readRaw('actions');
        expect(stored).toMatchObject({ action_id: 'new-act', user: userB });
        expect(idOf(harness, created?._id)).toBe(stored._id);
      });
    });

    describe('deleteAction', () => {
      it('deletes the first matching action and resolves to it', async () => {
        const first = action({ action_id: 'act-1' });
        const second = action({ action_id: 'act-2' });
        await harness.seedRaw('actions', [first, second]);
        const deleted = await harness.createStores().actions.deleteAction({ actionId: 'act-1' });
        expect(deleted).toMatchObject({ action_id: 'act-1' });
        expect(idOf(harness, deleted?._id)).toBe(first._id);
        expect((await harness.readRaw('actions')).map((record) => record._id)).toEqual([
          second._id,
        ]);
      });

      it('resolves null when nothing matches', async () => {
        expect(await harness.createStores().actions.deleteAction({ actionId: 'none' })).toBeNull();
      });
    });

    describe('deleteActions', () => {
      it('scopes deletes to the owning user and counts them', async () => {
        await harness.seedRaw('actions', [
          action({ action_id: 'act-1', agent_id: 'agent-1', user: userA }),
          action({ action_id: 'act-2', agent_id: 'agent-1', user: userB }),
        ]);
        const { actions } = harness.createStores();
        expect(await actions.deleteActions({ agentId: 'agent-1', user: userB })).toBe(1);
        expect((await actions.getActions({}, true)).map((item) => item.action_id)).toEqual([
          'act-1',
        ]);
      });

      it('does not delete every action when given an unrecognized criterion', async () => {
        await harness.seedRaw('actions', [action(), action({ action_id: 'act-2' })]);
        await expect(
          harness
            .createStores()
            .actions.deleteActions({ agent_id: 'agent-1' } as unknown as ActionQuery),
        ).rejects.toThrow("Unknown query criterion: 'agent_id'");
        expect(await harness.readRaw('actions')).toHaveLength(2);
      });

      it('does not delete every action when a misspelled criterion carries undefined', async () => {
        await harness.seedRaw('actions', [action(), action({ action_id: 'act-2' })]);
        await expect(
          harness
            .createStores()
            .actions.deleteActions({ agent_id: undefined } as unknown as ActionQuery),
        ).rejects.toThrow("Unknown query criterion: 'agent_id'");
        expect(await harness.readRaw('actions')).toHaveLength(2);
      });

      it('resolves 0 when nothing matches', async () => {
        expect(await harness.createStores().actions.deleteActions({ actionId: 'none' })).toBe(0);
      });
    });
  });
}
