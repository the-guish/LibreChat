/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `TokenListStore` contract (`~/ports/tokenList`), ported from `methods/tokenList.spec.ts`:
 * a user's unexpired tokens of one type, newest first. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import type { ContractHarness } from './harness';
import { idOf, useContractHarness } from './support';

export function describeTokenListContract(harness: ContractHarness): void {
  describe(`TokenListStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const token = (
      userId: string,
      type: string,
      identifier: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      _id: harness.ids.generate(),
      userId,
      type,
      identifier,
      token: `${type}:${identifier}`,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    });

    describe('findTokensOfUser', () => {
      it("returns every token of the type the user holds, and only that user's", async () => {
        const user = harness.ids.generate();
        const other = harness.ids.generate();
        await harness.seedRaw('tokens', [
          token(user, 'pr_oauth', 'github:github.com'),
          token(user, 'pr_oauth', 'gitlab:gitlab.com'),
          token(user, 'mcp_oauth', 'server'),
          token(other, 'pr_oauth', 'github:github.com'),
        ]);
        const found = await harness
          .createStores()
          .tokenLists.findTokensOfUser({ userId: user, type: 'pr_oauth' });
        expect(found.map((item) => item.identifier).sort()).toEqual([
          'github:github.com',
          'gitlab:gitlab.com',
        ]);
        expect(found.every((item) => idOf(harness, item.userId) === user)).toBe(true);
      });

      it('leaves out expired tokens and returns the newest first', async () => {
        const user = harness.ids.generate();
        await harness.seedRaw('tokens', [
          token(user, 'pr_oauth', 'older', { createdAt: new Date(Date.now() - 2000) }),
          token(user, 'pr_oauth', 'newer', { createdAt: new Date(Date.now() - 1000) }),
          token(user, 'pr_oauth', 'expired', { expiresAt: new Date(Date.now() - 60_000) }),
        ]);
        const found = await harness
          .createStores()
          .tokenLists.findTokensOfUser({ userId: user, type: 'pr_oauth' });
        expect(found.map((item) => item.identifier)).toEqual(['newer', 'older']);
      });

      it('returns at most a hundred tokens', async () => {
        const user = harness.ids.generate();
        const base = Date.now() - 200_000;
        await harness.seedRaw(
          'tokens',
          Array.from({ length: 101 }, (_, index) =>
            token(user, 'pr_oauth', `host-${index}`, { createdAt: new Date(base + index * 1000) }),
          ),
        );
        const found = await harness
          .createStores()
          .tokenLists.findTokensOfUser({ userId: user, type: 'pr_oauth' });
        expect(found).toHaveLength(100);
        expect(found[0].identifier).toBe('host-100');
        expect(found.map((item) => item.identifier)).not.toContain('host-0');
      });

      it('returns nothing for a user without tokens', async () => {
        expect(
          await harness
            .createStores()
            .tokenLists.findTokensOfUser({ userId: harness.ids.generate(), type: 'pr_oauth' }),
        ).toEqual([]);
      });
    });
  });
}
