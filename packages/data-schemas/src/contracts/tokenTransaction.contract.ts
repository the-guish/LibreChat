/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `TokenTransactionStore` contract (`~/ports/tokenTransaction`), ported from
 * `methods/transaction.spec.ts` and `methods/transaction.nullBalance.spec.ts`: the ledger reads,
 * deletes and bulk inserts, transactions valued at the model's rates (an endpoint token config
 * gives fixed rates here) and applied to the balance, the balance writes (a user's balance is
 * their oldest record; credits never go below zero; first writes racing on a missing record
 * converge on one record), the null-credit compare-and-set, and the reservations that hold
 * credits for in-flight requests (concurrent admissions never hold more than the balance, renewal
 * and release by reservation id, expired reservations pruned with their credits), with the
 * auto-refill and reset that admission and reads apply once per period.
 *
 * Cases that interleave a write between a read and the guarded write, or make the ledger fail,
 * through spies (the lost-acknowledgement cleanup, refill settings changing mid-attempt, a
 * failed refill recording replayed), or that count driver writes, stay in the method specs;
 * so do the rate tables, premium pricing and multiplier fallbacks of the pure `tx` helpers,
 * which are not on a port. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import type { IBalance } from '~/types';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';

const MODEL = 'contract-model';
/** Fixed rates for {@link MODEL}: prompt 2, completion 4, cache write 3, cache read 0.5. */
const endpointTokenConfig = { [MODEL]: { prompt: 2, completion: 4, write: 3, read: 0.5 } };
const inFuture = (ms = 60_000) => new Date(Date.now() + ms);
const inPast = (ms = 1_000) => new Date(Date.now() - ms);
const refillable = {
  tokenCredits: 0,
  autoRefillEnabled: true,
  refillAmount: 1000,
  refillIntervalValue: 30,
  refillIntervalUnit: 'days',
  refillMode: 'add',
  lastRefill: new Date('2020-01-01T00:00:00.000Z'),
};

export function describeTokenTransactionContract(harness: ContractHarness): void {
  describe(`TokenTransactionStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().tokenTransactions;
    const newId = () => harness.ids.generate();
    /** Two new ids, the first older (lower) than the second. */
    const olderAndNewer = () => [newId(), newId()].sort() as [string, string];
    /** Seeds balance records raw (no defaults) for `user`, each with its own id unless given. */
    const seedBalance = async (user: string, record: RawRecord = {}): Promise<string> => {
      const _id = (record._id as string | undefined) ?? newId();
      await harness.seedRaw('balances', [{ _id, user, ...record }]);
      return _id;
    };
    const balancesOf = (user: string) => readRawWhere(harness, 'balances', { user });
    const stateOf = async (user: string) => (await balancesOf(user))[0];
    const ledgerOf = (user: string, where: RawRecord = {}) =>
      readRawWhere(harness, 'transactions', { user, ...where });
    const reserve = (user: string, amount: number, reservationId = newId()) =>
      stores().reserveBalance({ user, amount, reservationId, expiresAt: inFuture() });
    const reservationIds = (record: RawRecord | undefined) =>
      ((record?.reservations as Array<{ id: string }> | undefined) ?? []).map(({ id }) => id);

    describe('getTransactions, deleteTransactions and bulkInsertTransactions', () => {
      it('stores the transactions as given, without touching any balance', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100 });
        await stores().bulkInsertTransactions([
          {
            user,
            conversationId: 'c1',
            tokenType: 'prompt',
            model: MODEL,
            context: 'message',
            rawAmount: -10,
            tokenValue: -20,
            rate: 2,
          },
          {
            user,
            conversationId: 'c1',
            tokenType: 'completion',
            model: MODEL,
            context: 'message',
            rawAmount: -5,
            tokenValue: -20,
            rate: 4,
          },
          { user, conversationId: 'c2', tokenType: 'credits', rawAmount: 50, tokenValue: 50 },
        ] as never);
        await stores().bulkInsertTransactions([]);
        expect((await stateOf(user)).tokenCredits).toBe(100);
        expect(await ledgerOf(user)).toHaveLength(3);
      });

      it('reads the transactions matching the criteria', async () => {
        const user = newId();
        const other = newId();
        await stores().bulkInsertTransactions([
          { user, conversationId: 'c1', context: 'message', tokenType: 'prompt', rawAmount: -1 },
          { user, conversationId: 'c1', context: 'title', tokenType: 'prompt', rawAmount: -2 },
          { user, conversationId: 'c2', context: 'message', tokenType: 'prompt', rawAmount: -3 },
          {
            user: other,
            conversationId: 'c1',
            context: 'message',
            tokenType: 'prompt',
            rawAmount: -4,
          },
        ] as never);
        const found = await stores().getTransactions({
          user,
          context: 'message',
          conversationId: 'c1',
        });
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          rawAmount: -1,
          tokenType: 'prompt',
          conversationId: 'c1',
        });
        expect(idOf(harness, found[0].user)).toBe(user);
        expect(found[0].createdAt).toBeInstanceOf(Date);
        expect(await stores().getTransactions({ user: harness.ids.toStoreId(user) })).toHaveLength(
          3,
        );
        expect(await stores().getTransactions({ user: newId() })).toEqual([]);
      });

      it('deletes the transactions matching the criteria, counting them', async () => {
        const user = newId();
        const other = newId();
        await stores().bulkInsertTransactions([
          { user, tokenType: 'prompt', rawAmount: -1 },
          { user, tokenType: 'completion', rawAmount: -2 },
          { user: other, tokenType: 'prompt', rawAmount: -3 },
        ] as never);
        expect((await stores().deleteTransactions({ user })).deletedCount).toBe(2);
        expect((await stores().deleteTransactions({ user })).deletedCount).toBe(0);
        expect(await harness.readRaw('transactions')).toHaveLength(1);
      });
    });

    describe('deleteBalances', () => {
      it('deletes every balance record matching the criteria, counting them', async () => {
        const user = newId();
        const other = newId();
        await seedBalance(user, { tokenCredits: 1 });
        await seedBalance(user, { tokenCredits: 2 });
        await seedBalance(other, { tokenCredits: 3 });
        expect((await stores().deleteBalances({ user })).deletedCount).toBe(2);
        expect(await harness.readRaw('balances')).toHaveLength(1);
      });
    });

    describe('updateBalance', () => {
      it('adds the increment to the credits and resolves the balance updated', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        const updated = await stores().updateBalance({ user, incrementValue: -250 });
        expect(updated.tokenCredits).toBe(750);
        expect(idOf(harness, updated.user)).toBe(user);
        expect((await stateOf(user)).tokenCredits).toBe(750);
      });

      it('never takes the credits below zero', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100 });
        expect((await stores().updateBalance({ user, incrementValue: -500 })).tokenCredits).toBe(0);
        expect((await stores().updateBalance({ user, incrementValue: 30 })).tokenCredits).toBe(30);
      });

      it('applies the given fields too', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100 });
        const lastRefill = new Date('2024-01-01T00:00:00Z');
        const updated = await stores().updateBalance({
          user,
          incrementValue: 10,
          setValues: { lastRefill, refillAmount: 5 },
        });
        expect(updated).toMatchObject({ tokenCredits: 110, refillAmount: 5 });
        expect(timeOf((await stateOf(user)).lastRefill)).toBe(lastRefill.getTime());
      });

      it('creates the balance from zero when the user has none', async () => {
        const user = newId();
        expect((await stores().updateBalance({ user, incrementValue: 25 })).tokenCredits).toBe(25);
        const other = newId();
        expect(
          (await stores().updateBalance({ user: other, incrementValue: -25 })).tokenCredits,
        ).toBe(0);
        expect(await balancesOf(user)).toHaveLength(1);
      });

      it("updates the user's oldest record only", async () => {
        const user = newId();
        const [older, newer] = olderAndNewer();
        await seedBalance(user, { _id: newer, tokenCredits: 5000 });
        await seedBalance(user, { _id: older, tokenCredits: 1000 });
        await stores().updateBalance({ user, incrementValue: -100 });
        const records = await balancesOf(user);
        expect(records.map(({ _id, tokenCredits }) => [_id, tokenCredits])).toEqual([
          [older, 900],
          [newer, 5000],
        ]);
      });

      it('lands every one of concurrent increments', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        await Promise.all([
          ...Array.from({ length: 5 }, () =>
            stores().updateBalance({ user, incrementValue: -100 }),
          ),
          ...Array.from({ length: 3 }, () => stores().updateBalance({ user, incrementValue: 50 })),
        ]);
        expect((await stateOf(user)).tokenCredits).toBe(650);
      });

      it('floors concurrent spends against one balance at zero', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100 });
        const results = await Promise.all(
          Array.from({ length: 4 }, () => stores().updateBalance({ user, incrementValue: -40 })),
        );
        expect((await stateOf(user)).tokenCredits).toBe(0);
        expect(results.map(({ tokenCredits }) => tokenCredits).sort((a, b) => a - b)).toEqual([
          0, 0, 20, 60,
        ]);
      });

      it('converges concurrent first writes for a user without a balance on one record', async () => {
        const user = newId();
        await Promise.all(
          Array.from({ length: 6 }, () => stores().updateBalance({ user, incrementValue: 10 })),
        );
        const records = await balancesOf(user);
        expect(records).toHaveLength(1);
        expect(records[0].tokenCredits).toBe(60);
      });
    });

    describe('findBalanceByUser', () => {
      it("resolves the user's oldest balance, or null", async () => {
        const user = newId();
        const [older, newer] = olderAndNewer();
        await seedBalance(user, { _id: newer, tokenCredits: 5000 });
        await seedBalance(user, { _id: older, tokenCredits: 1000 });
        const balance = await stores().findBalanceByUser(user);
        expect(idOf(harness, balance?._id)).toBe(older);
        expect(balance?.tokenCredits).toBe(1000);
        expect(idOf(harness, balance?.user)).toBe(user);
        expect(await stores().findBalanceByUser(newId())).toBeNull();
      });

      it('leaves reservation state out, unless asked for the unexpired reserved credits', async () => {
        const user = newId();
        await seedBalance(user, {
          tokenCredits: 1000,
          reservedCredits: 1200,
          reservations: [
            { id: 'live', amount: 300, expiresAt: inFuture() },
            { id: 'stale', amount: 900, expiresAt: inPast() },
          ],
        });
        const plain = await stores().findBalanceByUser(user);
        for (const field of ['reservations', 'reservedCredits', 'pendingRefill']) {
          expect(plain).not.toHaveProperty(field);
        }
        const withReserved = await stores().findBalanceByUser(user, {
          includeReservedCredits: true,
        });
        expect(withReserved?.tokenCredits).toBe(1000);
        expect(withReserved?.reservedCredits).toBe(300);
        expect(withReserved).not.toHaveProperty('reservations');
        expect(withReserved).not.toHaveProperty('pendingRefill');
      });

      it('applies a due reset first, once, recording it in the ledger', async () => {
        const user = newId();
        await seedBalance(user, { ...refillable, refillMode: 'reset', tokenCredits: 400 });
        expect((await stores().findBalanceByUser(user, { applyReset: false }))?.tokenCredits).toBe(
          400,
        );
        expect(await ledgerOf(user)).toEqual([]);
        const balance = await stores().findBalanceByUser(user);
        expect(balance?.tokenCredits).toBe(1000);
        expect(balance).not.toHaveProperty('pendingRefill');
        const resets = await ledgerOf(user, { context: 'balanceReset' });
        expect(resets).toHaveLength(1);
        expect(resets[0]).toMatchObject({ tokenType: 'credits', rawAmount: 600, tokenValue: 600 });
        await stores().setBalanceCredits(user, 600);
        expect((await stores().findBalanceByUser(user))?.tokenCredits).toBe(600);
        expect(await ledgerOf(user, { context: 'balanceReset' })).toHaveLength(1);
        expect((await stateOf(user)).pendingRefill ?? null).toBeNull();
      });

      it('never resets a balance without due reset settings', async () => {
        const user = newId();
        await seedBalance(user, { ...refillable, refillMode: 'add', tokenCredits: 400 });
        const disabled = newId();
        await seedBalance(disabled, {
          ...refillable,
          refillMode: 'reset',
          autoRefillEnabled: false,
          tokenCredits: 400,
        });
        expect((await stores().findBalanceByUser(user))?.tokenCredits).toBe(400);
        expect((await stores().findBalanceByUser(disabled))?.tokenCredits).toBe(400);
        expect(await harness.readRaw('transactions')).toEqual([]);
      });

      it('applies one reset across concurrent reads, keeping held reservations', async () => {
        const user = newId();
        await seedBalance(user, {
          ...refillable,
          refillMode: 'reset',
          tokenCredits: 1500,
          reservedCredits: 700,
          reservations: [{ id: 'held', amount: 700, expiresAt: inFuture() }],
        });
        await Promise.all([
          stores().findBalanceByUser(user),
          stores().findBalanceByUser(user),
          reserve(user, 200),
        ]);
        const stored = await stateOf(user);
        expect(stored.tokenCredits).toBe(1000);
        expect(stored.reservedCredits).toBe(900);
        expect(reservationIds(stored)).toContain('held');
        expect(await ledgerOf(user, { context: 'balanceReset' })).toHaveLength(1);
      });
    });

    describe('upsertBalanceFields', () => {
      it('creates the balance with the fields and the insert-only ones', async () => {
        const user = newId();
        const created = await stores().upsertBalanceFields(
          user,
          { tokenCredits: 50 },
          { refillAmount: 5, tokenCredits: 999 },
        );
        expect(created).toMatchObject({ tokenCredits: 50, refillAmount: 5 });
        expect(idOf(harness, created?.user)).toBe(user);
        expect(await balancesOf(user)).toHaveLength(1);
      });

      it('sets the fields on the existing balance, ignoring the insert-only ones', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100, refillAmount: 1 });
        const updated = await stores().upsertBalanceFields(
          user,
          { autoRefillEnabled: true },
          { refillAmount: 5 },
        );
        expect(updated).toMatchObject({
          tokenCredits: 100,
          refillAmount: 1,
          autoRefillEnabled: true,
        });
        expect(updated).not.toHaveProperty('reservations');
      });

      it('resolves the existing balance unchanged for empty fields', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100 });
        expect((await stores().upsertBalanceFields(user, {}))?.tokenCredits).toBe(100);
      });

      it("writes the user's oldest record only", async () => {
        const user = newId();
        const [older, newer] = olderAndNewer();
        await seedBalance(user, { _id: newer, tokenCredits: 5000 });
        await seedBalance(user, { _id: older, tokenCredits: 1000 });
        const updated = await stores().upsertBalanceFields(user, { refillAmount: 7 });
        expect(idOf(harness, updated?._id)).toBe(older);
        expect((await balancesOf(user)).map(({ refillAmount }) => refillAmount ?? null)).toEqual([
          7,
          null,
        ]);
      });

      it('converges concurrent creations on one record', async () => {
        const user = newId();
        await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            stores().upsertBalanceFields(user, { refillAmount: index }, { tokenCredits: 10 }),
          ),
        );
        const records = await balancesOf(user);
        expect(records).toHaveLength(1);
        expect(records[0].tokenCredits).toBe(10);
      });

      it('applies a reset the new settings make due', async () => {
        const user = newId();
        await seedBalance(user, { ...refillable, refillMode: 'reset', tokenCredits: 500 });
        expect(
          (await stores().upsertBalanceFields(user, { refillAmount: 2000 }))?.tokenCredits,
        ).toBe(2000);
        const resets = await ledgerOf(user, { context: 'balanceReset' });
        expect(resets.map(({ rawAmount }) => rawAmount)).toEqual([1500]);
      });
    });

    describe('initializeNullBalanceCredits', () => {
      it('sets the credits and sync fields on a balance whose credits are null or absent', async () => {
        const withNull = newId();
        const absent = newId();
        await seedBalance(withNull, { tokenCredits: null });
        await seedBalance(absent);
        const initialized = await stores().initializeNullBalanceCredits(withNull, 500, {
          autoRefillEnabled: true,
          refillAmount: 100,
        });
        expect(initialized).toMatchObject({
          tokenCredits: 500,
          autoRefillEnabled: true,
          refillAmount: 100,
        });
        expect(idOf(harness, initialized?.user)).toBe(withNull);
        expect((await stores().initializeNullBalanceCredits(absent, 7, {}))?.tokenCredits).toBe(7);
        expect((await stateOf(absent)).tokenCredits).toBe(7);
      });

      it('leaves a balance with credits untouched and creates none', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 0 });
        expect(await stores().initializeNullBalanceCredits(user, 500)).toBeNull();
        expect(await stores().initializeNullBalanceCredits(newId(), 500)).toBeNull();
        expect((await stateOf(user)).tokenCredits).toBe(0);
        expect(await harness.readRaw('balances')).toHaveLength(1);
      });

      it("updates the user's oldest null-credit record", async () => {
        const user = newId();
        const [older, newer] = olderAndNewer();
        await seedBalance(user, { _id: newer, tokenCredits: null });
        await seedBalance(user, { _id: older, tokenCredits: null });
        const record = await stores().initializeNullBalanceCredits(user, 1);
        expect(idOf(harness, record?._id)).toBe(older);
      });

      it('initializes once when concurrent initializations race', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: null });
        const results = await Promise.all(
          [100, 200, 300, 400].map((credits) =>
            stores().initializeNullBalanceCredits(user, credits),
          ),
        );
        const winners = results.filter((result): result is IBalance => result != null);
        expect(winners).toHaveLength(1);
        expect((await stateOf(user)).tokenCredits).toBe(winners[0].tokenCredits);
      });
    });

    describe('setBalanceCredits', () => {
      it('sets the credits, creating the balance when the user has none', async () => {
        const user = newId();
        expect((await stores().setBalanceCredits(user, 300))?.tokenCredits).toBe(300);
        expect((await stores().setBalanceCredits(user, 10))?.tokenCredits).toBe(10);
        expect(await balancesOf(user)).toHaveLength(1);
      });

      it('never applies a reset that is due', async () => {
        const user = newId();
        await seedBalance(user, { ...refillable, refillMode: 'reset', tokenCredits: 500 });
        expect((await stores().setBalanceCredits(user, 42))?.tokenCredits).toBe(42);
        expect(await harness.readRaw('transactions')).toEqual([]);
      });
    });

    describe('findBalanceCreditsByUsers', () => {
      it("resolves each listed user's credits, leaving out users without a balance", async () => {
        const [rich, unset, absent, other] = [newId(), newId(), newId(), newId()];
        const [older, newer] = olderAndNewer();
        await seedBalance(rich, { _id: newer, tokenCredits: 9 });
        await seedBalance(rich, { _id: older, tokenCredits: 500 });
        await seedBalance(unset, { tokenCredits: null });
        await seedBalance(other, { tokenCredits: 1 });
        const rows = await stores().findBalanceCreditsByUsers([
          rich,
          harness.ids.toStoreId(unset),
          absent,
        ]);
        expect(rows.sort((a, b) => a.user.localeCompare(b.user))).toEqual(
          [
            { user: rich, tokenCredits: 500 },
            { user: unset, tokenCredits: null },
          ].sort((a, b) => a.user.localeCompare(b.user)),
        );
        expect(await stores().findBalanceCreditsByUsers([])).toEqual([]);
      });
    });

    describe('createTransaction', () => {
      it('records the transaction at the model rate and applies it to the balance', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 10_000 });
        const result = await stores().createTransaction({
          user,
          conversationId: 'c1',
          model: MODEL,
          context: 'message',
          tokenType: 'prompt',
          rawAmount: -100,
          endpointTokenConfig,
          balance: { enabled: true },
        });
        expect(result).toEqual({ rate: 2, user, balance: 9800, prompt: -200 });
        const [stored] = await ledgerOf(user);
        expect(stored).toMatchObject({
          conversationId: 'c1',
          model: MODEL,
          context: 'message',
          tokenType: 'prompt',
          rawAmount: -100,
          rate: 2,
          tokenValue: -200,
        });
        expect(stored).not.toHaveProperty('endpointTokenConfig');
        expect(stored).not.toHaveProperty('balance');
        expect((await stateOf(user)).tokenCredits).toBe(9800);
      });

      it('charges an incomplete completion 15% more, rounded up', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 10_000 });
        const result = await stores().createTransaction({
          user,
          model: MODEL,
          context: 'incomplete',
          tokenType: 'completion',
          rawAmount: -10,
          endpointTokenConfig,
          balance: { enabled: true },
        });
        expect(result?.completion).toBe(Math.ceil(-40 * 1.15));
        expect(result?.rate).toBeCloseTo(4 * 1.15);
        expect((await stateOf(user)).tokenCredits).toBe(10_000 + Math.ceil(-40 * 1.15));
      });

      it('records credits at rate 1', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 10 });
        const result = await stores().createTransaction({
          user,
          tokenType: 'credits',
          context: 'admin',
          rawAmount: 90,
          balance: { enabled: true },
        });
        expect(result).toMatchObject({ rate: 1, balance: 100, credits: 90 });
      });

      it('records the transaction only, without a result, when the balance is disabled', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        for (const balance of [undefined, { enabled: false }]) {
          expect(
            await stores().createTransaction({
              user,
              model: MODEL,
              tokenType: 'prompt',
              rawAmount: -10,
              endpointTokenConfig,
              balance,
              transactions: { enabled: true },
            }),
          ).toBeUndefined();
        }
        expect(await ledgerOf(user)).toHaveLength(2);
        expect((await stateOf(user)).tokenCredits).toBe(1000);
      });

      it('records nothing when transactions are disabled or the amount is NaN', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        const base = {
          user,
          model: MODEL,
          tokenType: 'prompt' as const,
          endpointTokenConfig,
          balance: { enabled: true },
        };
        expect(
          await stores().createTransaction({
            ...base,
            rawAmount: -10,
            transactions: { enabled: false },
          }),
        ).toBeUndefined();
        expect(await stores().createTransaction({ ...base, rawAmount: NaN })).toBeUndefined();
        expect(await harness.readRaw('transactions')).toEqual([]);
        expect((await stateOf(user)).tokenCredits).toBe(1000);
      });

      it('creates the balance of a user without one, floored at zero', async () => {
        const user = newId();
        const result = await stores().createTransaction({
          user,
          model: MODEL,
          tokenType: 'prompt',
          rawAmount: -10,
          endpointTokenConfig,
          balance: { enabled: true },
        });
        expect(result?.balance).toBe(0);
        expect(await balancesOf(user)).toHaveLength(1);
      });

      it('applies every one of concurrent spends', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 10_000 });
        await Promise.all(
          Array.from({ length: 8 }, () =>
            stores().createTransaction({
              user,
              model: MODEL,
              tokenType: 'completion',
              rawAmount: -100,
              endpointTokenConfig,
              balance: { enabled: true },
            }),
          ),
        );
        expect((await stateOf(user)).tokenCredits).toBe(10_000 - 8 * 400);
        expect(await ledgerOf(user)).toHaveLength(8);
      });
    });

    describe('createStructuredTransaction', () => {
      it('values input, cache write and cache read tokens at their own rates', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100_000 });
        const result = await stores().createStructuredTransaction({
          user,
          model: MODEL,
          context: 'message',
          tokenType: 'prompt',
          inputTokens: -100,
          writeTokens: -40,
          readTokens: -200,
          endpointTokenConfig,
          balance: { enabled: true },
        });
        const value = 100 * 2 + 40 * 3 + 200 * 0.5;
        expect(result).toMatchObject({ user, prompt: -value, balance: 100_000 - value });
        expect(result?.rate).toBeCloseTo(value / 340);
        const [stored] = await ledgerOf(user);
        expect(stored).toMatchObject({
          tokenType: 'prompt',
          inputTokens: -100,
          writeTokens: -40,
          readTokens: -200,
          rawAmount: -340,
          tokenValue: -value,
        });
      });

      it('values 1-hour cache writes at their own rate, never more of them than writes', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100_000 });
        const config = { [MODEL]: { ...endpointTokenConfig[MODEL], write1h: 10 } };
        const result = await stores().createStructuredTransaction({
          user,
          model: MODEL,
          tokenType: 'prompt',
          inputTokens: 0,
          writeTokens: -40,
          write1hTokens: -100,
          readTokens: 0,
          endpointTokenConfig: config,
          balance: { enabled: true },
        });
        expect(result?.prompt).toBe(-(40 * 10));
      });

      it('falls back to the input rate without cache rates', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100_000 });
        const result = await stores().createStructuredTransaction({
          user,
          model: MODEL,
          tokenType: 'prompt',
          inputTokens: -10,
          writeTokens: -10,
          readTokens: -10,
          endpointTokenConfig: { [MODEL]: { prompt: 2, completion: 4 } },
          balance: { enabled: true },
        });
        expect(result?.prompt).toBe(-60);
      });

      it('values an incomplete completion like a transaction', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100_000 });
        const result = await stores().createStructuredTransaction({
          user,
          model: MODEL,
          context: 'incomplete',
          tokenType: 'completion',
          rawAmount: 10,
          endpointTokenConfig,
          balance: { enabled: true },
        });
        expect(result?.completion).toBe(Math.ceil(-40 * 1.15));
        expect((await ledgerOf(user))[0].rawAmount).toBe(-10);
      });

      it('records the transaction only when the balance is disabled, and nothing when transactions are', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        const base = {
          user,
          model: MODEL,
          tokenType: 'prompt' as const,
          inputTokens: -10,
          endpointTokenConfig,
        };
        expect(
          await stores().createStructuredTransaction({ ...base, balance: { enabled: false } }),
        ).toBeUndefined();
        expect(
          await stores().createStructuredTransaction({
            ...base,
            balance: { enabled: true },
            transactions: { enabled: false },
          }),
        ).toBeUndefined();
        expect(await ledgerOf(user)).toHaveLength(1);
        expect((await stateOf(user)).tokenCredits).toBe(1000);
      });
    });

    describe('reserveBalance', () => {
      it('resolves null for a user without a balance and no initial balance', async () => {
        expect(await reserve(newId(), 100)).toBeNull();
        expect(await harness.readRaw('balances')).toEqual([]);
      });

      it('creates a missing balance from the initial balance and holds against it', async () => {
        const user = newId();
        expect(
          await stores().reserveBalance({
            user,
            amount: 400,
            reservationId: 'r1',
            expiresAt: inFuture(),
            initialBalance: { user, tokenCredits: 1000 },
          }),
        ).toEqual({ reserved: true, balance: 1000 });
        const stored = await stateOf(user);
        expect(stored.tokenCredits).toBe(1000);
        expect(stored.reservedCredits).toBe(400);
        expect(stored.reservations).toEqual([
          { id: 'r1', amount: 400, expiresAt: expect.any(Date) },
        ]);
      });

      it('converges racing first admissions on one record, holding only what it covers', async () => {
        const user = newId();
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            stores().reserveBalance({
              user,
              amount: 400,
              reservationId: newId(),
              expiresAt: inFuture(),
              initialBalance: { user, tokenCredits: 1000 },
            }),
          ),
        );
        expect(await balancesOf(user)).toHaveLength(1);
        expect(results.filter((result) => result?.reserved)).toHaveLength(2);
        expect((await stateOf(user)).reservedCredits).toBe(800);
      });

      it('admits concurrent requests only up to the credits no other request holds', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        const results = await Promise.all(Array.from({ length: 10 }, () => reserve(user, 300)));
        expect(results.filter((result) => result?.reserved)).toHaveLength(3);
        for (const result of results.filter((entry) => !entry?.reserved)) {
          expect(result?.balance).toBeLessThan(300);
        }
        const stored = await stateOf(user);
        expect(stored.tokenCredits).toBe(1000);
        expect(stored.reservations).toHaveLength(3);
        expect(stored.reservedCredits).toBe(900);
      });

      it('admits every request of a funded burst', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 100_000 });
        const results = await Promise.all(Array.from({ length: 30 }, () => reserve(user, 100)));
        expect(results.every((result) => result?.reserved)).toBe(true);
        const stored = await stateOf(user);
        expect(stored.reservations).toHaveLength(30);
        expect(stored.reservedCredits).toBe(3000);
      });

      it('reports the unheld balance when it refuses', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        expect(await reserve(user, 600)).toEqual({ reserved: true, balance: 1000 });
        expect(await reserve(user, 600)).toEqual({ reserved: false, balance: 400 });
        expect((await stateOf(user)).reservedCredits).toBe(600);
      });

      it('holds whole credits', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        expect(await reserve(user, 0.3, 'fraction')).toEqual({ reserved: true, balance: 1000 });
        const stored = await stateOf(user);
        expect(stored.reservedCredits).toBe(1);
        expect(stored.reservations).toEqual([
          { id: 'fraction', amount: 1, expiresAt: expect.any(Date) },
        ]);
      });

      it('admits a zero-cost request without holding anything', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 0 });
        expect(await reserve(user, 0)).toEqual({ reserved: true, balance: 0 });
        const stored = await stateOf(user);
        expect(stored.reservations ?? []).toEqual([]);
        expect(stored.reservedCredits ?? null).toBeNull();
      });

      it('prunes expired reservations together with their credits', async () => {
        const user = newId();
        await seedBalance(user, {
          tokenCredits: 1000,
          reservedCredits: 1300,
          reservations: [
            { id: 'stale-1', amount: 900, expiresAt: inPast() },
            { id: 'live', amount: 100, expiresAt: inFuture() },
            { id: 'stale-2', amount: 300, expiresAt: inPast(5_000) },
          ],
        });
        expect(await reserve(user, 600, 'new')).toEqual({ reserved: true, balance: 900 });
        const stored = await stateOf(user);
        expect(reservationIds(stored)).toEqual(['live', 'new']);
        expect(stored.reservedCredits).toBe(700);
      });

      it("holds against the user's oldest record only", async () => {
        const user = newId();
        const [older, newer] = olderAndNewer();
        await seedBalance(user, { _id: newer, tokenCredits: 5000 });
        await seedBalance(user, { _id: older, tokenCredits: 1000 });
        expect(await reserve(user, 2000)).toEqual({ reserved: false, balance: 1000 });
        await reserve(user, 400);
        const [oldRecord, newRecord] = await balancesOf(user);
        expect(oldRecord).toMatchObject({ _id: older, reservedCredits: 400 });
        expect(newRecord.reservedCredits ?? null).toBeNull();
      });

      it('synchronizes a changed refill policy before admission without changing credits', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 500, autoRefillEnabled: false });
        const result = await stores().reserveBalance({
          user,
          amount: 100,
          reservationId: 'r',
          expiresAt: inFuture(),
          refillPolicy: {
            autoRefillEnabled: true,
            refillMode: 'add',
            refillAmount: 50,
            refillIntervalValue: 1,
            refillIntervalUnit: 'days',
          },
        });
        expect(result).toEqual({ reserved: true, balance: 500 });
        expect(await stateOf(user)).toMatchObject({
          tokenCredits: 500,
          autoRefillEnabled: true,
          refillAmount: 50,
          refillIntervalValue: 1,
        });
      });

      describe('auto-refill', () => {
        it('applies one refill per period across concurrent admissions, recorded once', async () => {
          const user = newId();
          await seedBalance(user, refillable);
          const results = await Promise.all(Array.from({ length: 10 }, () => reserve(user, 150)));
          expect(results.filter((result) => result?.reserved)).toHaveLength(6);
          const stored = await stateOf(user);
          expect(stored.tokenCredits).toBe(1000);
          expect(timeOf(stored.lastRefill)).toBeGreaterThan(refillable.lastRefill.getTime());
          expect(stored.pendingRefill ?? null).toBeNull();
          const refills = await ledgerOf(user, { context: 'autoRefill' });
          expect(refills).toHaveLength(1);
          expect(refills[0]).toMatchObject({ tokenType: 'credits', rawAmount: 1000 });
        });

        it('does not refill while the unheld balance covers the request', async () => {
          const user = newId();
          await seedBalance(user, { ...refillable, tokenCredits: 500 });
          expect(await reserve(user, 100)).toEqual({ reserved: true, balance: 500 });
          expect(await ledgerOf(user)).toEqual([]);
        });

        it('still refills when the refilled balance cannot cover the request', async () => {
          const user = newId();
          await seedBalance(user, { ...refillable, refillAmount: 100 });
          expect(await reserve(user, 500)).toEqual({ reserved: false, balance: 100 });
          const stored = await stateOf(user);
          expect(stored.tokenCredits).toBe(100);
          expect(stored.reservations ?? []).toEqual([]);
        });

        it('in reset mode replaces the allowance before admission, keeping reservations', async () => {
          const user = newId();
          await seedBalance(user, { ...refillable, refillMode: 'reset', tokenCredits: 500 });
          expect(await reserve(user, 100)).toEqual({ reserved: true, balance: 1000 });
          expect((await stateOf(user)).tokenCredits).toBe(1000);
          expect(
            (await ledgerOf(user, { context: 'balanceReset' })).map(({ rawAmount }) => rawAmount),
          ).toEqual([500]);
        });

        it.each([0, -1, 0.5])(
          'never grants repeated allowances for the invalid interval %s',
          async (refillIntervalValue) => {
            const user = newId();
            await seedBalance(user, {
              ...refillable,
              refillMode: 'reset',
              refillIntervalValue,
              tokenCredits: 500,
            });
            await stores().findBalanceByUser(user);
            await reserve(user, 100);
            expect((await stateOf(user)).tokenCredits).toBe(500);
            expect(await harness.readRaw('transactions')).toEqual([]);
          },
        );
      });
    });

    describe('renewBalanceReservation', () => {
      it('extends a live reservation and never resurrects a released one', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        await reserve(user, 300, 'live');
        await reserve(user, 200, 'released');
        await reserve(user, 100, 'other');
        await stores().releaseBalanceReservation({ user, reservationId: 'released', amount: 200 });
        const renewedUntil = new Date(Date.now() + 3_600_000);
        await stores().renewBalanceReservation({
          user,
          reservationId: 'live',
          expiresAt: renewedUntil,
        });
        await stores().renewBalanceReservation({
          user,
          reservationId: 'released',
          expiresAt: renewedUntil,
        });
        await stores().renewBalanceReservation({
          user: newId(),
          reservationId: 'live',
          expiresAt: inPast(),
        });
        const stored = await stateOf(user);
        const reservations = stored.reservations as Array<{ id: string; expiresAt: Date }>;
        expect(reservations.map(({ id }) => id)).toEqual(['live', 'other']);
        expect(timeOf(reservations[0].expiresAt)).toBe(renewedUntil.getTime());
        expect(timeOf(reservations[1].expiresAt)).toBeLessThan(renewedUntil.getTime());
        expect(stored.reservedCredits).toBe(400);
      });

      it('keeps a renewed reservation counting past its first expiry', async () => {
        const user = newId();
        await seedBalance(user, {
          tokenCredits: 1000,
          reservedCredits: 900,
          reservations: [{ id: 'held', amount: 900, expiresAt: inFuture(200) }],
        });
        await stores().renewBalanceReservation({
          user,
          reservationId: 'held',
          expiresAt: inFuture(),
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await reserve(user, 600)).toEqual({ reserved: false, balance: 100 });
        expect(reservationIds(await stateOf(user))).toEqual(['held']);
      });
    });

    describe('releaseBalanceReservation', () => {
      it('returns the credits to later admissions, once', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        await reserve(user, 600, 'first');
        const release = { user, reservationId: 'first', amount: 600 };
        await Promise.all([
          stores().releaseBalanceReservation(release),
          stores().releaseBalanceReservation(release),
        ]);
        const stored = await stateOf(user);
        expect(stored.reservedCredits).toBe(0);
        expect(stored.reservations).toEqual([]);
        expect(await reserve(user, 600)).toEqual({ reserved: true, balance: 1000 });
      });

      it('releases the whole credits it held for a fractional amount', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        await reserve(user, 0.3, 'fraction');
        await stores().releaseBalanceReservation({ user, reservationId: 'fraction', amount: 0.3 });
        expect((await stateOf(user)).reservedCredits).toBe(0);
      });

      it('is a no-op for an unknown reservation, another amount, or a non-positive amount', async () => {
        const user = newId();
        await seedBalance(user, { tokenCredits: 1000 });
        await reserve(user, 300, 'held');
        await stores().releaseBalanceReservation({ user, reservationId: 'unknown', amount: 300 });
        await stores().releaseBalanceReservation({ user, reservationId: 'held', amount: 200 });
        await stores().releaseBalanceReservation({ user, reservationId: 'held', amount: 0 });
        await stores().releaseBalanceReservation({
          user: newId(),
          reservationId: 'held',
          amount: 300,
        });
        const stored = await stateOf(user);
        expect(reservationIds(stored)).toEqual(['held']);
        expect(stored.reservedCredits).toBe(300);
      });
    });
  });
}
