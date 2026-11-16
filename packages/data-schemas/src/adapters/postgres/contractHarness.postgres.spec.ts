import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from './contractHarness';
import { DATA_STORE_METHODS } from '~/ports';

/**
 * The PostgreSQL contract harness (docs/postgres-port/PHASE4.md §7). The shared smoke contract
 * (`contracts/smoke.contract.ts`) also reads and writes through the banner store, which is a
 * stand-in until S3, so it does not run here yet; these cases are its raw-mode half (stores
 * built, ids, raw seeding and reading in canonical form, reset), plus what raw mode adds on
 * PostgreSQL (hidden paths, child tables, `_extra`).
 */
describePostgres('contract harness: postgres', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  const harness = createPostgresContractHarness({
    connect: async () => database.uri,
    release: async () => undefined,
  });

  beforeAll(() => harness.setup(), 120_000);
  afterAll(() => harness.teardown());
  beforeEach(() => harness.reset());

  const banner = (overrides: Record<string, unknown> = {}) => ({
    _id: harness.ids.generate(),
    bannerId: 'banner-1',
    message: 'Hello',
    displayFrom: new Date('2020-01-01T00:00:00.000Z'),
    type: 'banner',
    isPublic: true,
    persistable: false,
    ...overrides,
  });

  it('builds every store of the DataStore (stand-ins until their S unit)', () => {
    const stores = harness.createStores();
    expect(Object.keys(stores).sort()).toEqual(Object.keys(DATA_STORE_METHODS).sort());
    for (const [store, methods] of Object.entries(DATA_STORE_METHODS)) {
      for (const method of methods as string[]) {
        expect(
          typeof (stores as unknown as Record<string, Record<string, unknown>>)[store][method],
        ).toBe('function');
      }
    }
  });

  it('generates ids of its own format', () => {
    const id = harness.ids.generate();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(harness.ids.isValid(id)).toBe(true);
    expect(harness.ids.toCanonicalString(id.toUpperCase())).toBe(id);
  });

  it('seeds raw records and reads them back in canonical form, oldest id first', async () => {
    const first = banner();
    const second = banner({ bannerId: 'banner-2' });
    await harness.seedRaw('banners', [second, first]);
    const records = await harness.readRaw('banners');
    expect(records).toEqual([first, second]);
    expect(records[0].displayFrom).toBeInstanceOf(Date);
  });

  it('casts declared values and keeps undeclared fields as given', async () => {
    const record = banner({ displayFrom: '2021-02-03T04:05:06.007Z', legacyField: { a: 1 } });
    await harness.seedRaw('banners', [record]);
    const [stored] = await harness.readRaw('banners');
    expect(stored.displayFrom).toEqual(new Date('2021-02-03T04:05:06.007Z'));
    expect(stored.legacyField).toEqual({ a: 1 });
    expect(stored).not.toHaveProperty('createdAt');
  });

  it('reads hidden paths and child tables, and keeps misfits', async () => {
    const id = harness.ids.generate();
    await harness.seedRaw('users', [
      {
        _id: id,
        email: 'raw@example.com',
        password: 'secret-hash',
        favorites: [{ agentId: 'a1' }],
        emailVerified: 'not a boolean',
      },
    ]);
    const [stored] = await harness.readRaw('users');
    expect(stored).toEqual({
      _id: id,
      email: 'raw@example.com',
      password: 'secret-hash',
      favorites: [{ agentId: 'a1' }],
      emailVerified: 'not a boolean',
    });
  });

  it('classifies duplicate keys with the descriptor fields', async () => {
    const record = banner();
    await harness.seedRaw('banners', [record]);
    const error = await harness.seedRaw('banners', [record]).catch((caught: unknown) => caught);
    expect(harness.errors.isDuplicateKey(error)).toBe(true);
    expect(harness.errors.duplicateKeyFields(error)).toEqual(['_id']);
  });

  it('resets every collection', async () => {
    await harness.seedRaw('banners', [banner()]);
    await harness.reset();
    expect(await harness.readRaw('banners')).toEqual([]);
  });
});
