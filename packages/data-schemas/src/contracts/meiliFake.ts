/**
 * An in-memory stand-in for the `meilisearch` package, for the search sync contract
 * (`searchSync.contract.ts`): a backend's runner replaces the package with it
 * (`jest.mock('meilisearch', () => jest.requireActual('./meiliFake').meilisearchModule)`), so
 * the backend's own code (the MongoDB plugin, the PostgreSQL search hooks) builds its client on
 * it, and the suite reads what reached the index through {@link fakeMeili}. Nothing here may
 * import `mongoose` or the MongoDB driver.
 *
 * What it models: indexes by name, created on first use, each with its primary key; documents
 * replaced whole by `addDocuments*` and merged by `updateDocuments`; deletes by id; paging with
 * `getDocuments`; every task succeeds at once. `search` matches the query, ignoring case, as a
 * substring of any string (or string array element) of a document (an empty query matches every
 * document), honors the `user = "<id>"` filter the callers send (quotes and backslashes escaped),
 * `limit`, `offset` and `attributesToRetrieve`, and returns hits in insertion order.
 */

type FakeDocument = Record<string, unknown>;

interface FakeIndex {
  primaryKey?: string;
  documents: Map<string, FakeDocument>;
  settings: Record<string, unknown>;
}

interface FakeState {
  indexes: Map<string, FakeIndex>;
  taskUid: number;
}

/** Shared through `globalThis`, so every copy of this module a suite loads sees one state. */
const STATE_KEY = Symbol.for('librechat.contracts.meiliFake');
const globalState = globalThis as unknown as Record<symbol, FakeState | undefined>;
const state = (): FakeState => (globalState[STATE_KEY] ??= { indexes: new Map(), taskUid: 0 });

const indexOf = (name: string): FakeIndex => {
  const indexes = state().indexes;
  let index = indexes.get(name);
  if (!index) {
    index = { documents: new Map(), settings: {} };
    indexes.set(name, index);
  }
  return index;
};

/** An enqueued task (every fake task succeeds at once). */
interface FakeTask {
  taskUid: number;
  status: string;
}

/** A search page. */
interface FakeSearchResponse {
  hits: FakeDocument[];
  query: string;
  offset: number;
  limit: number;
  estimatedTotalHits: number;
  processingTimeMs: number;
}

const task = (): FakeTask => {
  const taskUid = ++state().taskUid;
  return { taskUid, status: 'enqueued' };
};

const keyOf = (index: FakeIndex, document: FakeDocument, primaryKey?: string): string => {
  index.primaryKey ??= primaryKey;
  const key = index.primaryKey ? document[index.primaryKey] : undefined;
  if (key === undefined || key === null) {
    throw new Error(
      `The fake MeiliSearch index has no primary key value in ${JSON.stringify(document)}`,
    );
  }
  return String(key);
};

/** The `user = "<id>"` filter, unescaped; `undefined` without a filter. */
function userFilter(filter: unknown): string | undefined {
  if (filter == null || filter === '') {
    return undefined;
  }
  const match = /^user = "((?:[^"\\]|\\.)*)"$/.exec(String(filter));
  if (!match) {
    throw new Error(`The fake MeiliSearch index does not support the filter ${String(filter)}`);
  }
  return match[1].replace(/\\(.)/g, '$1');
}

const matchesQuery = (document: FakeDocument, query: string): boolean => {
  if (query === '') {
    return true;
  }
  const needle = query.toLowerCase();
  return Object.values(document).some((value) =>
    (Array.isArray(value) ? value : [value]).some(
      (item) => typeof item === 'string' && item.toLowerCase().includes(needle),
    ),
  );
};

class FakeMeiliIndex {
  constructor(readonly uid: string) {}

  async getRawInfo(): Promise<{ uid: string; primaryKey: string | null }> {
    return { uid: this.uid, primaryKey: indexOf(this.uid).primaryKey ?? null };
  }

  async getSettings(): Promise<Record<string, unknown>> {
    return { ...indexOf(this.uid).settings };
  }

  async updateSettings(settings: Record<string, unknown>): Promise<FakeTask> {
    Object.assign(indexOf(this.uid).settings, settings);
    return task();
  }

  async addDocuments(
    documents: FakeDocument[],
    options?: { primaryKey?: string },
  ): Promise<FakeTask> {
    const index = indexOf(this.uid);
    for (const document of documents) {
      index.documents.set(keyOf(index, document, options?.primaryKey), { ...document });
    }
    return task();
  }

  async addDocumentsInBatches(
    documents: FakeDocument[],
    _batchSize?: number,
    options?: { primaryKey?: string },
  ): Promise<FakeTask[]> {
    return [await this.addDocuments(documents, options)];
  }

  async updateDocuments(
    documents: FakeDocument[],
    options?: { primaryKey?: string },
  ): Promise<FakeTask> {
    const index = indexOf(this.uid);
    for (const document of documents) {
      const key = keyOf(index, document, options?.primaryKey);
      index.documents.set(key, { ...(index.documents.get(key) ?? {}), ...document });
    }
    return task();
  }

  async deleteDocument(id: string | number): Promise<FakeTask> {
    indexOf(this.uid).documents.delete(String(id));
    return task();
  }

  async deleteDocuments(ids: Array<string | number>): Promise<FakeTask> {
    const documents = indexOf(this.uid).documents;
    for (const id of ids) {
      documents.delete(String(id));
    }
    return task();
  }

  async getDocuments(
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ results: FakeDocument[]; offset: number; limit: number; total: number }> {
    const all = [...indexOf(this.uid).documents.values()];
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;
    return {
      results: all.slice(offset, offset + limit).map((document) => ({ ...document })),
      offset,
      limit,
      total: all.length,
    };
  }

  async search(
    query: string | null | undefined,
    params: {
      filter?: unknown;
      limit?: number;
      offset?: number;
      attributesToRetrieve?: string[];
    } = {},
  ): Promise<FakeSearchResponse> {
    const user = userFilter(params.filter);
    const matching = [...indexOf(this.uid).documents.values()].filter(
      (document) =>
        (user === undefined || document.user === user) && matchesQuery(document, query ?? ''),
    );
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 20;
    const retrieve = params.attributesToRetrieve;
    const hits = matching
      .slice(offset, offset + limit)
      .map((document) =>
        retrieve && !retrieve.includes('*')
          ? Object.fromEntries(Object.entries(document).filter(([key]) => retrieve.includes(key)))
          : { ...document },
      );
    return {
      hits,
      query: query ?? '',
      offset,
      limit,
      estimatedTotalHits: matching.length,
      processingTimeMs: 0,
    };
  }
}

class FakeMeiliSearch {
  constructor(readonly config: { host: string; apiKey?: string; timeout?: number }) {}

  index(name: string): FakeMeiliIndex {
    return new FakeMeiliIndex(name);
  }

  async createIndex(name: string, options?: { primaryKey?: string }): Promise<FakeTask> {
    indexOf(name).primaryKey ??= options?.primaryKey;
    return task();
  }

  async waitForTask(taskUid: number): Promise<{ taskUid: number; status: string; error: null }> {
    return { taskUid, status: 'succeeded', error: null };
  }

  async health(): Promise<{ status: string }> {
    return { status: 'available' };
  }
}

class FakeMeiliSearchTimeOutError extends Error {}

/** What a runner's `jest.mock('meilisearch', …)` factory returns. */
export const meilisearchModule: {
  MeiliSearch: typeof FakeMeiliSearch;
  MeiliSearchTimeOutError: typeof FakeMeiliSearchTimeOutError;
} = {
  MeiliSearch: FakeMeiliSearch,
  MeiliSearchTimeOutError: FakeMeiliSearchTimeOutError,
};

/** The suite's view of the fake indexes. */
export const fakeMeili: {
  documents(index: string): FakeDocument[];
  document(index: string, id: string): FakeDocument | undefined;
  seed(index: string, primaryKey: string, documents: FakeDocument[]): void;
  reset(): void;
} = {
  /** Every document of `index`, in insertion order. */
  documents(index: string): FakeDocument[] {
    return [...indexOf(index).documents.values()].map((document) => ({ ...document }));
  },
  /** The document of `index` with primary key `id`, or `undefined`. */
  document(index: string, id: string): FakeDocument | undefined {
    const document = indexOf(index).documents.get(id);
    return document ? { ...document } : undefined;
  },
  /** Puts `documents` into `index` directly (an index entry the database may not hold). */
  seed(index: string, primaryKey: string, documents: FakeDocument[]): void {
    const target = indexOf(index);
    for (const document of documents) {
      target.documents.set(keyOf(target, document, primaryKey), { ...document });
    }
  },
  /** Empties every index (their primary keys are kept). */
  reset(): void {
    for (const index of state().indexes.values()) {
      index.documents.clear();
    }
  },
};
