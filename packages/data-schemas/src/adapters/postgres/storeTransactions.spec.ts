import { sql } from 'kysely';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { StoreTransactions } from '~/ports/storeTransactions';
import type { PostgresKysely } from './types';
import {
  resolvePostgresExecutor,
  isOpenPostgresTransaction,
  createPostgresStoreTransactions,
} from './storeTransactions';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { STORE_TRANSACTIONS_METHODS } from '~/ports/storeTransactions';
import logger from '~/config/winston';

describePostgres('PostgreSQL StoreTransactions', () => {
  const database = usePostgresTestDatabase();
  let db: PostgresKysely;
  let transactions: StoreTransactions;

  const insert = (executor: PostgresKysely, id: number) =>
    sql`INSERT INTO items (id) VALUES (${id})`.execute(executor);
  const ids = async () =>
    (await sql<{ id: number }>`SELECT id FROM items ORDER BY id`.execute(db)).rows.map(
      (row) => row.id,
    );

  beforeAll(async () => {
    db = database.kysely({ max: 4 });
    transactions = createPostgresStoreTransactions(() => db);
    await sql`CREATE TABLE items (id integer PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE deferred_items (
      id integer,
      CONSTRAINT deferred_items_id UNIQUE (id) DEFERRABLE INITIALLY DEFERRED
    )`.execute(db);
  });

  beforeEach(() => database.truncateAll());

  it('implements every StoreTransactions method', () => {
    for (const method of STORE_TRANSACTIONS_METHODS) {
      expect(typeof transactions[method]).toBe('function');
    }
  });

  it('commits what fn writes with the transaction, and resolves to its result', async () => {
    const result = await transactions.transaction(async (tx) => {
      expect(tx).toBeDefined();
      const executor = resolvePostgresExecutor(db, tx);
      await insert(executor, 1);
      await insert(executor, 2);
      /** Not visible outside the transaction before the commit. */
      expect(await ids()).toEqual([]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await ids()).toEqual([1, 2]);
  });

  it('rolls back and rethrows the same error when fn rejects', async () => {
    const failure = new Error('boom');
    await expect(
      transactions.transaction(async (tx) => {
        await insert(resolvePostgresExecutor(db, tx), 1);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await ids()).toEqual([]);
  });

  it('rolls back when a statement fails inside the transaction', async () => {
    await insert(db, 1);
    await expect(
      transactions.transaction(async (tx) => {
        const executor = resolvePostgresExecutor(db, tx);
        await insert(executor, 2);
        await insert(executor, 1);
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await ids()).toEqual([1]);
  });

  it('rejects when the commit fails, and rolls back', async () => {
    const afterCommit = jest.fn(async () => undefined);
    await expect(
      transactions.transaction(async (tx) => {
        const executor = resolvePostgresExecutor(db, tx);
        await sql`INSERT INTO deferred_items (id) VALUES (1), (1)`.execute(executor);
        await transactions.runAfterCommit(tx, afterCommit);
      }),
    ).rejects.toMatchObject({ code: '23505' });
    const { rows } = await sql`SELECT * FROM deferred_items`.execute(db);
    expect(rows).toEqual([]);
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('logs a failed rollback and rethrows the original error', async () => {
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const failure = new Error('original');
    await expect(
      transactions.transaction(async (tx) => {
        const executor = resolvePostgresExecutor(db, tx);
        await insert(executor, 1);
        /** The server ends this connection, so the rollback cannot be sent. */
        await sql`SELECT pg_terminate_backend(pg_backend_pid())`.execute(executor).catch(() => {
          /* the terminated statement itself fails */
        });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('Error rolling back transaction'),
      expect.anything(),
    );
    expect(await ids()).toEqual([]);
  });

  it('hands out an opaque, frozen handle that stops resolving once the transaction ends', async () => {
    let kept: object | undefined;
    await transactions.transaction(async (tx) => {
      kept = tx;
      expect(Object.isFrozen(tx)).toBe(true);
      expect(Object.keys(tx as object)).toEqual([]);
      expect(isOpenPostgresTransaction(tx)).toBe(true);
    });
    expect(isOpenPostgresTransaction(kept)).toBe(false);
    expect(() => resolvePostgresExecutor(db, kept)).toThrow('already ended');
    expect(() => resolvePostgresExecutor(db, {})).toThrow('Not a transaction');
    expect(resolvePostgresExecutor(db, undefined)).toBe(db);
  });

  describe('runAfterCommit', () => {
    it('runs right away without a transaction', async () => {
      const order: string[] = [];
      await transactions.runAfterCommit(undefined, async () => {
        order.push('ran');
      });
      expect(order).toEqual(['ran']);
    });

    it('defers work to the commit, starts it in the order queued, and waits for it', async () => {
      const order: string[] = [];
      const result = await transactions.transaction(async (tx) => {
        await insert(resolvePostgresExecutor(db, tx), 1);
        await transactions.runAfterCommit(tx, async () => {
          order.push('first starts');
          order.push(`first sees ${(await ids()).join(',')}`);
        });
        await transactions.runAfterCommit(tx, async () => {
          order.push('second starts');
        });
        order.push('fn done');
        return 'result';
      });
      order.push('resolved');
      expect(result).toBe('result');
      /** Started one after the other once committed (and so seeing the commit), run concurrently. */
      expect(order).toEqual([
        'fn done',
        'first starts',
        'second starts',
        'first sees 1',
        'resolved',
      ]);
    });

    it('never runs deferred work when the transaction rolls back', async () => {
      const deferred = jest.fn(async () => undefined);
      await expect(
        transactions.transaction(async (tx) => {
          await transactions.runAfterCommit(tx, deferred);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(deferred).not.toHaveBeenCalled();
    });

    it('ignores the failure of deferred work (the commit stands)', async () => {
      const later = jest.fn(async () => undefined);
      await expect(
        transactions.transaction(async (tx) => {
          await insert(resolvePostgresExecutor(db, tx), 1);
          await transactions.runAfterCommit(tx, async () => {
            throw new Error('deferred failure');
          });
          await transactions.runAfterCommit(tx, () => {
            throw new Error('synchronous failure');
          });
          await transactions.runAfterCommit(tx, later);
        }),
      ).resolves.toBeUndefined();
      expect(later).toHaveBeenCalledTimes(1);
      expect(await ids()).toEqual([1]);
    });

    it('runs deferred work in the async context it was queued in', async () => {
      const context = new AsyncLocalStorage<string>();
      const seen: Array<string | undefined> = [];
      await context.run('outer', () =>
        transactions.transaction(async (tx) => {
          await context.run('inner', () =>
            transactions.runAfterCommit(tx, async () => {
              seen.push(context.getStore());
            }),
          );
        }),
      );
      expect(seen).toEqual(['inner']);
    });

    it('runs right away for a transaction that has ended', async () => {
      let kept: object | undefined;
      await transactions.transaction(async (tx) => {
        kept = tx;
      });
      const order: string[] = [];
      await transactions.runAfterCommit(kept, async () => {
        order.push('ran');
      });
      expect(order).toEqual(['ran']);
    });
  });

  describe('nesting', () => {
    it('starts an unrelated transaction: the inner one commits even if the outer rolls back', async () => {
      const order: string[] = [];
      await expect(
        transactions.transaction(async (outer) => {
          await insert(resolvePostgresExecutor(db, outer), 1);
          await transactions.runAfterCommit(outer, async () => {
            order.push('outer after commit');
          });
          await transactions.transaction(async (inner) => {
            expect(inner).not.toBe(outer);
            await insert(resolvePostgresExecutor(db, inner), 2);
            await transactions.runAfterCommit(inner, async () => {
              order.push('inner after commit');
            });
          });
          order.push('inner resolved');
          throw new Error('outer fails');
        }),
      ).rejects.toThrow('outer fails');
      expect(order).toEqual(['inner after commit', 'inner resolved']);
      expect(await ids()).toEqual([2]);
    });

    it('runs each transaction’s deferred work at its own commit', async () => {
      const order: string[] = [];
      await transactions.transaction(async (outer) => {
        await transactions.runAfterCommit(outer, async () => {
          order.push('outer');
        });
        await transactions.transaction(async (inner) => {
          await transactions.runAfterCommit(inner, async () => {
            order.push('inner');
          });
        });
        order.push('outer fn done');
      });
      expect(order).toEqual(['inner', 'outer fn done', 'outer']);
    });
  });

  it('throws from transaction while the database is not available', async () => {
    const unconnected = createPostgresStoreTransactions(() => {
      throw new Error('PostgreSQL is not connected');
    });
    await expect(unconnected.transaction(async () => 1)).rejects.toThrow('not connected');
  });
});
