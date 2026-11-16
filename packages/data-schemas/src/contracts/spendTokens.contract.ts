/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SpendTokensStore` contract (`~/ports/spendTokens`, the `tokenSpending` store), ported from
 * `methods/spendTokens.spec.ts` and the spending cases of `methods/transaction.spec.ts`: a prompt
 * and a completion transaction per call, each only when its count is given (structured: only when
 * non-zero), negative counts treated as zero, the balance never taken below zero (also by
 * concurrent spends), the 1-hour cache writes, and neither method throwing. Rates come from an
 * endpoint token config; the rate tables and premium pricing of the pure `tx` helpers stay in the
 * method specs. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import { readRawWhere, useContractHarness } from './support';

const MODEL = 'contract-model';
/** Fixed rates for {@link MODEL}: prompt 2, completion 4, cache write 3, cache read 0.5. */
const endpointTokenConfig = { [MODEL]: { prompt: 2, completion: 4, write: 3, read: 0.5 } };

export function describeSpendTokensContract(harness: ContractHarness): void {
  describe(`SpendTokensStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().tokenSpending;
    const newUser = async (tokenCredits: number | null = 10_000): Promise<string> => {
      const user = harness.ids.generate();
      if (tokenCredits != null) {
        await harness.seedRaw('balances', [{ _id: harness.ids.generate(), user, tokenCredits }]);
      }
      return user;
    };
    const txData = (user: string, extra: RawRecord = {}) => ({
      user,
      conversationId: 'convo',
      model: MODEL,
      context: 'message',
      endpointTokenConfig,
      balance: { enabled: true },
      ...extra,
    });
    const ledger = async (user: string) =>
      (await readRawWhere(harness, 'transactions', { user })).sort((a, b) =>
        String(a.tokenType).localeCompare(String(b.tokenType)),
      );
    const credits = async (user: string) =>
      (await readRawWhere(harness, 'balances', { user }))[0]?.tokenCredits;

    describe('spendTokens', () => {
      it('records a prompt and a completion transaction and spends their value', async () => {
        const user = await newUser();
        await stores().spendTokens(txData(user), { promptTokens: 100, completionTokens: 50 });
        const [completion, prompt] = await ledger(user);
        expect(completion).toMatchObject({
          tokenType: 'completion',
          rawAmount: -50,
          rate: 4,
          tokenValue: -200,
          conversationId: 'convo',
          context: 'message',
          model: MODEL,
        });
        expect(prompt).toMatchObject({
          tokenType: 'prompt',
          rawAmount: -100,
          rate: 2,
          tokenValue: -200,
        });
        expect(await credits(user)).toBe(10_000 - 400);
      });

      it('records a zero count as a zero transaction, and skips an absent one', async () => {
        const user = await newUser();
        await stores().spendTokens(txData(user), { promptTokens: 100, completionTokens: 0 });
        const records = await ledger(user);
        expect(records.map(({ tokenType, rawAmount }) => [tokenType, rawAmount])).toEqual([
          ['completion', 0],
          ['prompt', -100],
        ]);
        const other = await newUser();
        await stores().spendTokens(txData(other), { promptTokens: 10 });
        expect((await ledger(other)).map(({ tokenType }) => tokenType)).toEqual(['prompt']);
        const none = await newUser();
        await stores().spendTokens(txData(none), {});
        expect(await ledger(none)).toEqual([]);
        expect(await credits(none)).toBe(10_000);
      });

      it('treats a negative count as zero tokens', async () => {
        const user = await newUser();
        await stores().spendTokens(txData(user), { promptTokens: -100, completionTokens: -5 });
        const records = await ledger(user);
        expect(records.map(({ rawAmount }) => Math.abs(Number(rawAmount ?? 0)))).toEqual([0, 0]);
        expect(await credits(user)).toBe(10_000);
      });

      it('records but does not spend with the balance disabled', async () => {
        const user = await newUser();
        await stores().spendTokens(txData(user, { balance: { enabled: false } }), {
          promptTokens: 100,
          completionTokens: 50,
        });
        expect(await ledger(user)).toHaveLength(2);
        expect(await credits(user)).toBe(10_000);
      });

      it('never takes the balance below zero, also across calls', async () => {
        const user = await newUser(300);
        await stores().spendTokens(txData(user), { promptTokens: 100, completionTokens: 50 });
        expect(await credits(user)).toBe(0);
        await stores().spendTokens(txData(user), { promptTokens: 100, completionTokens: 50 });
        expect(await credits(user)).toBe(0);
        for (const record of await ledger(user)) {
          expect(record.tokenValue as number).toBeLessThan(0);
        }
      });

      it('spends every one of concurrent calls against one balance', async () => {
        const user = await newUser(100_000);
        await Promise.all(
          Array.from({ length: 10 }, () =>
            stores().spendTokens(txData(user), { promptTokens: 100, completionTokens: 50 }),
          ),
        );
        expect(await credits(user)).toBe(100_000 - 10 * 400);
        expect(await ledger(user)).toHaveLength(20);
      });

      it('creates a balance floored at zero for a user without one, and never throws', async () => {
        const user = await newUser(null);
        await expect(
          stores().spendTokens(txData(user), { promptTokens: 10, completionTokens: 10 }),
        ).resolves.toBeUndefined();
        expect(await credits(user)).toBe(0);
        await expect(
          stores().spendTokens(txData('not-an-id'), { promptTokens: 10 }),
        ).resolves.toBeUndefined();
      });
    });

    describe('spendStructuredTokens', () => {
      it('records the structured prompt and the completion, resolving both results', async () => {
        const user = await newUser(100_000);
        const { prompt, completion } = await stores().spendStructuredTokens(txData(user), {
          promptTokens: { input: 100, write: 40, read: 200 },
          completionTokens: 50,
        });
        const promptValue = 100 * 2 + 40 * 3 + 200 * 0.5;
        expect(prompt).toMatchObject({ user, prompt: -promptValue });
        expect(completion).toMatchObject({
          user,
          completion: -200,
          balance: 100_000 - promptValue - 200,
        });
        const [completionRecord, promptRecord] = await ledger(user);
        expect(promptRecord).toMatchObject({
          inputTokens: -100,
          writeTokens: -40,
          readTokens: -200,
          rawAmount: -340,
          tokenValue: -promptValue,
        });
        expect(completionRecord).toMatchObject({ rawAmount: -50, tokenValue: -200 });
        expect(await credits(user)).toBe(100_000 - promptValue - 200);
      });

      it('skips the completion when it is zero, and the prompt when absent', async () => {
        const user = await newUser();
        const onlyPrompt = await stores().spendStructuredTokens(txData(user), {
          promptTokens: { input: 10 },
          completionTokens: 0,
        });
        expect(onlyPrompt.completion).toBeUndefined();
        expect(onlyPrompt.prompt?.prompt).toBe(-20);
        const onlyCompletion = await stores().spendStructuredTokens(txData(user), {
          completionTokens: 5,
        });
        expect(onlyCompletion.prompt).toBeUndefined();
        expect(onlyCompletion.completion?.completion).toBe(-20);
        expect(await stores().spendStructuredTokens(txData(user), {})).toEqual({
          prompt: undefined,
          completion: undefined,
        });
        expect(await ledger(user)).toHaveLength(2);
      });

      it('bills the 1-hour share of the writes at the 1-hour rate, never more than the writes', async () => {
        const user = await newUser(100_000);
        const config = { [MODEL]: { ...endpointTokenConfig[MODEL], write1h: 10 } };
        const { prompt } = await stores().spendStructuredTokens(
          txData(user, { endpointTokenConfig: config }),
          { promptTokens: { input: 0, write: 40, write1h: 15, read: 0 } },
        );
        expect(prompt?.prompt).toBe(-(25 * 3 + 15 * 10));
        const capped = await stores().spendStructuredTokens(
          txData(user, { endpointTokenConfig: config }),
          { promptTokens: { write: 40, write1h: 100 } },
        );
        expect(capped.prompt?.prompt).toBe(-(40 * 10));
      });

      it('treats negative counts as zero tokens', async () => {
        const user = await newUser();
        const { prompt, completion } = await stores().spendStructuredTokens(txData(user), {
          promptTokens: { input: -10, write: -5, read: 20 },
          completionTokens: -7,
        });
        expect(prompt?.prompt).toBe(-10);
        expect(Math.abs(completion?.completion ?? 0)).toBe(0);
        expect((await ledger(user)).find(({ tokenType }) => tokenType === 'prompt')).toMatchObject({
          rawAmount: -20,
        });
      });

      it('never takes the balance below zero, and never throws', async () => {
        const user = await newUser(100);
        const result = await stores().spendStructuredTokens(txData(user), {
          promptTokens: { input: 100 },
          completionTokens: 100,
        });
        expect(result.completion?.balance).toBe(0);
        expect(await credits(user)).toBe(0);
        await expect(
          stores().spendStructuredTokens(txData('not-an-id'), { completionTokens: 1 }),
        ).resolves.toEqual({ prompt: undefined, completion: undefined });
      });
    });
  });
}
