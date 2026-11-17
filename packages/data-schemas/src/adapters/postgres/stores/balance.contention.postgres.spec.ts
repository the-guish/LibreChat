import type { ContractHarness, RawRecord } from '~/contracts/harness';
import type { DataStore } from '~/ports';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from '../contractHarness';
import { createPostgresDataStoreBackend } from '../backend';

/**
 * Contention specs of the PostgreSQL balance stores (docs/postgres-port/PHASE4.md §3.5, R2):
 * parallel calls on separate pool clients never lose a credit update, never hold more than the
 * balance, never release a reservation (or its credits) twice, and the null-credit
 * compare-and-set initializes once. Each case runs with the shadow check off (the production
 * path: one statement per guarded write, rechecked on the locked row) and on (the
 * lock-then-write path the contract suites take). After every case the reserved total equals the
 * sum of the reservations held.
 */
const MODEL = 'contention-model';
const endpointTokenConfig = { [MODEL]: { prompt: 2, completion: 4 } };
const inFuture = (ms = 60_000) => new Date(Date.now() + ms);
const inPast = (ms = 1_000) => new Date(Date.now() - ms);

describePostgres('PostgreSQL balance stores under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  describe.each([
    ['shadow check off', false],
    ['shadow check on', true],
  ])('%s', (_title, shadowCheck) => {
    const harness: ContractHarness = createPostgresContractHarness(
      { connect: async () => database.uri, release: async () => undefined },
      { backend: createPostgresDataStoreBackend({ shadowCheck }) },
    );
    let stores: DataStore;

    beforeAll(async () => {
      await harness.setup();
      stores = harness.createStores();
    }, 120_000);
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const newId = () => harness.ids.generate();
    const balancesOf = async (user: string) =>
      (await harness.readRaw('balances')).filter((record) => record.user === user);
    const stateOf = async (user: string) => (await balancesOf(user))[0];
    const seedBalance = async (user: string, record: RawRecord = {}) => {
      await harness.seedRaw('balances', [{ _id: newId(), user, ...record }]);
    };
    const held = (record: RawRecord | undefined) =>
      (record?.reservations as Array<{ id: string; amount: number }> | undefined) ?? [];
    /** The reserved total always equals the sum of the reservations held. */
    const expectConsistent = (record: RawRecord | undefined) => {
      const total = held(record).reduce((sum, { amount }) => sum + amount, 0);
      expect((record?.reservedCredits as number | undefined) ?? 0).toBe(total);
    };
    const reserve = (user: string, amount: number, reservationId = newId()) =>
      stores.tokenTransactions.reserveBalance({
        user,
        amount,
        reservationId,
        expiresAt: inFuture(),
      });

    it('loses none of 40 parallel credit updates', async () => {
      const user = newId();
      await seedBalance(user, { tokenCredits: 100_000 });
      const increments = Array.from({ length: 40 }, (_, index) =>
        index % 4 === 0 ? 250 : -(index * 10),
      );
      const results = await Promise.all(
        increments.map((incrementValue) =>
          stores.tokenTransactions.updateBalance({ user, incrementValue }),
        ),
      );
      const expected = 100_000 + increments.reduce((sum, value) => sum + value, 0);
      expect((await stateOf(user)).tokenCredits).toBe(expected);
      /** Each result is the balance after its own update, the last one the total. */
      expect(results.map(({ tokenCredits }) => tokenCredits)).toContain(expected);
    });

    it('floors 20 parallel spends at zero, each applied to the balance the one before left', async () => {
      const user = newId();
      await seedBalance(user, { tokenCredits: 500 });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          stores.tokenTransactions.updateBalance({ user, incrementValue: -70 }),
        ),
      );
      expect((await stateOf(user)).tokenCredits).toBe(0);
      expect(results.map(({ tokenCredits }) => tokenCredits).sort((a, b) => b - a)).toEqual([
        430,
        360,
        290,
        220,
        150,
        80,
        10,
        ...Array.from({ length: 13 }, () => 0),
      ]);
    });

    it('applies every one of 30 parallel spends recorded in the ledger', async () => {
      const user = newId();
      await seedBalance(user, { tokenCredits: 1_000_000 });
      await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          stores.tokenSpending.spendTokens(
            {
              user,
              model: MODEL,
              conversationId: `c${index % 3}`,
              endpointTokenConfig,
              balance: { enabled: true },
            },
            { promptTokens: 100, completionTokens: 10 * index },
          ),
        ),
      );
      const ledger = await stores.tokenTransactions.getTransactions({ user });
      expect(ledger).toHaveLength(60);
      const spent = ledger.reduce((sum, { tokenValue }) => sum + (tokenValue ?? 0), 0);
      expect((await stateOf(user)).tokenCredits).toBe(1_000_000 + spent);
      expect(spent).toBe(-(30 * 100 * 2 + 4 * 10 * ((29 * 30) / 2)));
    });

    it('holds no more than the balance across 25 parallel admissions', async () => {
      const user = newId();
      await seedBalance(user, { tokenCredits: 1000 });
      const results = await Promise.all(Array.from({ length: 25 }, () => reserve(user, 100)));
      expect(results.filter((result) => result?.reserved)).toHaveLength(10);
      const stored = await stateOf(user);
      expect(stored.tokenCredits).toBe(1000);
      expect(held(stored)).toHaveLength(10);
      expect(stored.reservedCredits).toBe(1000);
      expectConsistent(stored);
    });

    it('releases each reservation and its credits once under parallel double releases', async () => {
      const user = newId();
      await seedBalance(user, { tokenCredits: 10_000 });
      const ids = Array.from({ length: 10 }, () => newId());
      for (const [index, id] of ids.entries()) {
        await reserve(user, 100 + index, id);
      }
      expect((await stateOf(user)).reservedCredits).toBe(10 * 100 + 45);
      await Promise.all(
        [...ids, ...ids].map((reservationId, index) =>
          stores.tokenTransactions.releaseBalanceReservation({
            user,
            reservationId,
            amount: 100 + (index % 10),
          }),
        ),
      );
      const stored = await stateOf(user);
      expect(held(stored)).toEqual([]);
      expect(stored.reservedCredits).toBe(0);
      expect(stored.tokenCredits).toBe(10_000);
    });

    it('keeps the reserved total equal to the held reservations under interleaved holds and releases', async () => {
      const user = newId();
      await seedBalance(user, { tokenCredits: 5000 });
      const first = Array.from({ length: 10 }, () => newId());
      for (const id of first) {
        await reserve(user, 200, id);
      }
      const results = await Promise.all([
        ...first.map((reservationId) =>
          stores.tokenTransactions
            .releaseBalanceReservation({ user, reservationId, amount: 200 })
            .then(() => null),
        ),
        ...Array.from({ length: 20 }, () => reserve(user, 150)),
      ]);
      const admitted = results.filter((result) => result?.reserved).length;
      const stored = await stateOf(user);
      expect(held(stored)).toHaveLength(admitted);
      expect(stored.reservedCredits).toBe(admitted * 150);
      expect(stored.reservedCredits as number).toBeLessThanOrEqual(5000);
      expectConsistent(stored);
    });

    it('never resurrects a reservation renewed while it is released', async () => {
      const user = newId();
      await seedBalance(user, { tokenCredits: 1000 });
      const ids = Array.from({ length: 8 }, () => newId());
      for (const id of ids) {
        await reserve(user, 50, id);
      }
      await Promise.all(
        ids.flatMap((reservationId) => [
          stores.tokenTransactions.renewBalanceReservation({
            user,
            reservationId,
            expiresAt: inFuture(3_600_000),
          }),
          stores.tokenTransactions.releaseBalanceReservation({ user, reservationId, amount: 50 }),
        ]),
      );
      const stored = await stateOf(user);
      expect(held(stored)).toEqual([]);
      expect(stored.reservedCredits).toBe(0);
    });

    it('prunes expired reservations once across parallel admissions', async () => {
      const user = newId();
      await seedBalance(user, {
        tokenCredits: 2000,
        reservedCredits: 1700,
        reservations: [
          { id: 'stale-1', amount: 800, expiresAt: inPast() },
          { id: 'live', amount: 100, expiresAt: inFuture() },
          { id: 'stale-2', amount: 800, expiresAt: inPast(5_000) },
        ],
      });
      const results = await Promise.all(Array.from({ length: 12 }, () => reserve(user, 200)));
      expect(results.filter((result) => result?.reserved)).toHaveLength(9);
      const stored = await stateOf(user);
      expect(held(stored).map(({ id }) => id)).toContain('live');
      expect(held(stored).some(({ id }) => id.startsWith('stale'))).toBe(false);
      expect(stored.reservedCredits).toBe(100 + 9 * 200);
      expectConsistent(stored);
    });

    it('initializes null credits once across 16 parallel compare-and-sets', async () => {
      const user = newId();
      await seedBalance(user, { tokenCredits: null });
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          stores.tokenTransactions.initializeNullBalanceCredits(user, 100 * (index + 1), {
            refillAmount: index,
          }),
        ),
      );
      const winners = results.filter((result) => result != null);
      expect(winners).toHaveLength(1);
      const stored = await stateOf(user);
      expect(stored.tokenCredits).toBe(winners[0]?.tokenCredits);
      expect(stored.refillAmount).toBe(winners[0]?.refillAmount);
    });

    it('loses neither a null-credit initialization nor a spend racing it', async () => {
      const users = Array.from({ length: 8 }, () => newId());
      for (const user of users) {
        await seedBalance(user, { tokenCredits: null });
      }
      const outcomes = await Promise.all(
        users.map((user) =>
          Promise.all([
            stores.tokenTransactions.initializeNullBalanceCredits(user, 1000),
            stores.tokenTransactions.updateBalance({ user, incrementValue: 30 }),
          ]),
        ),
      );
      for (const [index, user] of users.entries()) {
        const [initialized] = outcomes[index];
        const { tokenCredits } = await stateOf(user);
        /** Initialized first: the spend lands on top. Spent first: the credits are set, so it stays out. */
        expect(tokenCredits).toBe(initialized ? 1030 : 30);
      }
    });

    it('applies one refill across 20 parallel admissions and reset readings, recorded once', async () => {
      const user = newId();
      await seedBalance(user, {
        tokenCredits: 300,
        autoRefillEnabled: true,
        refillAmount: 2000,
        refillIntervalValue: 30,
        refillIntervalUnit: 'days',
        refillMode: 'reset',
        lastRefill: new Date('2020-01-01T00:00:00.000Z'),
      });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          index % 4 === 0
            ? stores.tokenTransactions.findBalanceByUser(user).then(() => null)
            : reserve(user, 150),
        ),
      );
      expect(results.filter((result) => result?.reserved)).toHaveLength(13);
      const stored = await stateOf(user);
      expect(stored.tokenCredits).toBe(2000);
      expect(stored.pendingRefill ?? null).toBeNull();
      expectConsistent(stored);
      const resets = (await harness.readRaw('transactions')).filter(
        (record) => record.user === user && record.context === 'balanceReset',
      );
      expect(resets).toHaveLength(1);
      expect(resets[0]).toMatchObject({ rawAmount: 1700 });
    });

    it('converges parallel first writes of many users on one record each', async () => {
      const users = Array.from({ length: 5 }, () => newId());
      await Promise.all(
        users.flatMap((user) =>
          Array.from({ length: 6 }, (_, index) =>
            index % 2 === 0
              ? stores.tokenTransactions.updateBalance({ user, incrementValue: 10 })
              : stores.tokenTransactions.upsertBalanceFields(user, { refillAmount: index }),
          ),
        ),
      );
      for (const user of users) {
        const records = await balancesOf(user);
        expect(records).toHaveLength(1);
        expect(records[0].tokenCredits).toBe(30);
      }
    });
  });
});
