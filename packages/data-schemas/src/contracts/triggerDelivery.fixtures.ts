/**
 * Fixtures shared by the `TriggerDeliveryStore` contract suites (`triggerDelivery*.contract.ts`):
 * the delivery inputs the method specs use (`methods/triggerDelivery.spec.ts`), the worker steps
 * (claim, begin, settle) every suite composes, and the raw reads and rewrites of the three
 * collections the store owns (`agenttriggerdeliveries`, `agenttriggerlanesequences`,
 * `agenttriggeruserpurges`).
 *
 * The method specs reach states a crashed writer, an older replica or an earlier build left
 * (a staging row, an orphaned lane reservation, a legacy shield, a lost marker) by writing to
 * the collections with the driver. The contracts reach them with `rewrite`: every record of the
 * collections the case uses is read raw, edited, and seeded back after a `reset`, so the case
 * states the stored shape the store must accept and never one backend's write primitive. Nothing
 * here may import `mongoose` or the MongoDB driver.
 */
import type {
  AgentTriggerDeliveryClaim,
  AgentTriggerDeliveryFailure,
  EnqueueAgentTriggerDeliveryInput,
} from '~/types';
import type { TriggerDeliveryStore } from '~/ports/triggerDelivery';
import type { ContractHarness, RawRecord } from './harness';
import type { WithIdLike } from '~/ports/common';

export const START: Date = new Date('2026-08-17T12:00:00.000Z');
export const SECOND = 1_000;
export const MINUTE = 60_000;
export const DAY: number = 24 * 60 * MINUTE;
/** How long a succeeded delivery is kept (`expiresAt` = `settledAt` + this). */
export const SUCCESS_RETENTION_MS: number = 90 * DAY;
/** The year-9999 fence a capability delivery shows workers that predate capabilities. */
export const LEGACY_SHIELD_AT: Date = new Date('9999-12-31T23:59:59.999Z');

export const DELIVERIES = 'agenttriggerdeliveries';
export const LANES = 'agenttriggerlanesequences';
export const PURGES = 'agenttriggeruserpurges';
export const USERS = 'users';
export const CONVERSATIONS = 'conversations';
export const MESSAGES = 'messages';
export const QUEUED_TURNS = 'agentqueuedturns';

/** The collections a `rewrite` keeps: every collection the trigger delivery suites seed. */
const REWRITTEN = [DELIVERIES, LANES, PURGES, USERS, CONVERSATIONS, MESSAGES, QUEUED_TURNS];

export const BACKGROUND_SOURCE = { id: 'background-tool-completion', type: 'internal' };
export const QUEUED_TURN_SOURCE = { id: 'agent-queued-turn', type: 'internal' };
export const SUBAGENT_SOURCE = { id: 'subagent-completion', type: 'internal' };
export const REMOTE_SOURCE = { id: 'source-key-1', type: 'remote_api_key' };

export type EnqueueInput = WithIdLike<EnqueueAgentTriggerDeliveryInput, 'user'>;

export interface ClaimOptions {
  workerId?: string;
  claimToken?: string;
  now?: Date;
  leaseUntil?: Date;
  workerCapabilities?: string[];
}

/** A claimed and begun delivery: its fence and the attempt number. */
export interface BegunAttempt {
  claim: AgentTriggerDeliveryClaim;
  fence: { id: string; workerId: string; claimToken: string };
  attempt: number;
}

export interface TriggerDeliveryFixtures {
  store(): TriggerDeliveryStore;
  /** A new owner id, as a hex string (the port takes `IdLike`). */
  newUser(): string;
  /** The store-id value of `hex`, as the store would hand it out. */
  storeId(hex: string): ReturnType<ContractHarness['ids']['toStoreId']>;
  at(ms: number, from?: Date): Date;
  enqueueInput(overrides?: Partial<EnqueueInput>): EnqueueInput;
  enqueue(
    overrides?: Partial<EnqueueInput>,
  ): ReturnType<TriggerDeliveryStore['enqueueAgentTriggerDelivery']>;
  failure(overrides?: Partial<AgentTriggerDeliveryFailure>): AgentTriggerDeliveryFailure;
  claim(options?: ClaimOptions): Promise<AgentTriggerDeliveryClaim | null>;
  /** Claims the next due delivery (it must be there) and begins an attempt under the claim. */
  claimAndBegin(options?: ClaimOptions): Promise<BegunAttempt>;
  /** Claims, begins and completes the next due delivery; its begun attempt. */
  deliver(
    options?: ClaimOptions & {
      result?: unknown;
      settledAt?: Date;
      handling?: Parameters<TriggerDeliveryStore['completeAgentTriggerDelivery']>[0]['handling'];
      awaitTerminalHandling?: true;
    },
  ): Promise<BegunAttempt>;
  /** Claims, begins and dead-letters the next due delivery; its begun attempt. */
  kill(options?: ClaimOptions & { settledAt?: Date; expiresAt?: Date }): Promise<BegunAttempt>;
  deliveries(): Promise<RawRecord[]>;
  /** The raw delivery of `deliveryKey` (or of `_id`). */
  raw(keyOrId: string): Promise<RawRecord | undefined>;
  lane(orderingKey: string): Promise<RawRecord | undefined>;
  purgeMarker(user: string): Promise<RawRecord | undefined>;
  /** A raw delivery record with every required field, `record` on top; its `_id`. */
  seedDelivery(record: RawRecord): Promise<string>;
  /** A staging row as a crashed enqueue leaves it (no lane sequence yet); its `_id`. */
  seedStaging(input: Partial<EnqueueInput>, record?: RawRecord): Promise<string>;
  seedLane(record: RawRecord): Promise<void>;
  /** A user record, holding the deletion fence `fenceStartedAt` when given. */
  seedUser(id: string, fenceStartedAt?: Date): Promise<void>;
  /**
   * Reads every record of the suites' collections, lets `edit` change them in place, and seeds
   * them back after a reset: the crash and older-build states the method specs write directly.
   */
  rewrite(edit: (collections: Record<string, RawRecord[]>) => void): Promise<void>;
  /**
   * Sets `patch` on the delivery of `deliveryKey` (or `_id`) through `rewrite`; a key set to
   * `undefined` is removed.
   */
  patchDelivery(
    keyOrId: string,
    patch: RawRecord | ((record: RawRecord) => RawRecord),
  ): Promise<void>;
  /** Removes the records of the collection `name` that `drop` selects, through `rewrite`. */
  dropRaw(name: string, drop: (record: RawRecord) => boolean): Promise<void>;
}

/** Applies `patch` to `record`, removing keys set to `undefined`. */
function applyPatch(record: RawRecord, patch: RawRecord): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete record[key];
    } else {
      record[key] = value;
    }
  }
}

export function createTriggerDeliveryFixtures(harness: ContractHarness): TriggerDeliveryFixtures {
  let counter = 0;
  const store = () => harness.createStores().agentTriggerDeliveries;
  const at = (ms: number, from: Date = START) => new Date(from.getTime() + ms);

  const enqueueInput = (overrides: Partial<EnqueueInput> = {}): EnqueueInput => {
    counter += 1;
    return {
      deliveryKey: `trigger_${counter}`,
      fingerprint: `fingerprint_${counter}`,
      orderingKey: 'ordering-1',
      envelope: { version: 1, delivery: counter },
      user: harness.ids.generate(),
      tenantId: 'tenant-1',
      availableAt: START,
      ...overrides,
    };
  };

  const claim = (options: ClaimOptions = {}) => {
    const now = options.now ?? START;
    return store().claimNextAgentTriggerDelivery({
      workerId: options.workerId ?? 'worker-1',
      claimToken: options.claimToken ?? 'claim-1',
      now,
      leaseUntil: options.leaseUntil ?? at(MINUTE, now),
      ...(options.workerCapabilities != null && { workerCapabilities: options.workerCapabilities }),
    });
  };

  const claimAndBegin = async (options: ClaimOptions = {}): Promise<BegunAttempt> => {
    const claimed = await claim(options);
    if (claimed == null) {
      throw new Error('Expected a due delivery to claim');
    }
    const fence = {
      id: claimed.id,
      workerId: claimed.leaseBy,
      claimToken: claimed.claimToken,
    };
    const attempt = await store().beginAgentTriggerDeliveryAttempt({
      ...fence,
      now: options.now ?? START,
    });
    if (attempt == null) {
      throw new Error('Expected the claim to begin an attempt');
    }
    return { claim: claimed, fence, attempt };
  };

  const failure = (
    overrides: Partial<AgentTriggerDeliveryFailure> = {},
  ): AgentTriggerDeliveryFailure => ({
    code: 'RATE_LIMITED',
    message: 'try later',
    certainty: 'definite',
    retryable: true,
    attemptedAt: START,
    status: 429,
    ...overrides,
  });

  const deliveries = () => harness.readRaw(DELIVERIES);
  const raw = async (keyOrId: string) =>
    (await deliveries()).find((row) => row.deliveryKey === keyOrId || row._id === keyOrId);

  const seedDelivery = async (record: RawRecord) => {
    counter += 1;
    const _id = (record._id as string | undefined) ?? harness.ids.generate();
    await harness.seedRaw(DELIVERIES, [
      {
        _id,
        deliveryKey: `seeded_${counter}`,
        fingerprint: `seeded_${counter}`,
        orderingKey: `seeded-lane-${counter}`,
        laneSequence: 1,
        envelope: { version: 1, delivery: counter },
        user: harness.ids.generate(),
        tenantId: 'tenant-1',
        status: 'pending',
        attempts: 0,
        availableAt: START,
        requeueCount: 0,
        createdAt: START,
        updatedAt: START,
        ...record,
      },
    ]);
    return _id;
  };

  const rewrite = async (edit: (collections: Record<string, RawRecord[]>) => void) => {
    const collections: Record<string, RawRecord[]> = {};
    for (const name of REWRITTEN) {
      collections[name] = await harness.readRaw(name);
    }
    edit(collections);
    await harness.reset();
    for (const name of REWRITTEN) {
      await harness.seedRaw(name, collections[name]);
    }
  };

  return {
    store,
    newUser: () => harness.ids.generate(),
    storeId: (hex) => harness.ids.toStoreId(hex),
    at,
    enqueueInput,
    enqueue: (overrides) => store().enqueueAgentTriggerDelivery(enqueueInput(overrides)),
    failure,
    claim,
    claimAndBegin,
    async deliver(options = {}) {
      const begun = await claimAndBegin(options);
      const settled = await store().completeAgentTriggerDelivery({
        ...begun.fence,
        attempt: begun.attempt,
        result: options.result ?? { ok: true },
        settledAt: options.settledAt ?? options.now ?? START,
        ...(options.handling != null && { handling: options.handling }),
        ...(options.awaitTerminalHandling != null && {
          awaitTerminalHandling: options.awaitTerminalHandling,
        }),
      });
      if (!settled) {
        throw new Error('Expected the attempt to complete');
      }
      return begun;
    },
    async kill(options = {}) {
      const begun = await claimAndBegin(options);
      const settled = await store().deadLetterAgentTriggerDelivery({
        ...begun.fence,
        attempt: begun.attempt,
        error: failure({ retryable: false }),
        settledAt: options.settledAt ?? options.now ?? START,
        ...(options.expiresAt != null && { expiresAt: options.expiresAt }),
      });
      if (!settled) {
        throw new Error('Expected the attempt to dead-letter');
      }
      return begun;
    },
    deliveries,
    raw,
    lane: async (orderingKey) =>
      (await harness.readRaw(LANES)).find((row) => row._id === orderingKey),
    purgeMarker: async (user) => (await harness.readRaw(PURGES)).find((row) => row._id === user),
    seedDelivery,
    async seedStaging(input, record = {}) {
      const { user, ...rest } = enqueueInput(input);
      return seedDelivery({
        ...rest,
        user: typeof user === 'string' ? user : user.toHexString(),
        laneSequence: 0,
        status: 'staging',
        attempts: 0,
        requeueCount: 0,
        ...record,
      });
    },
    async seedLane(record) {
      await harness.seedRaw(LANES, [{ createdAt: START, updatedAt: START, ...record }]);
    },
    async seedUser(id, fenceStartedAt) {
      counter += 1;
      await harness.seedRaw(USERS, [
        {
          _id: id,
          email: `trigger-user-${counter}@example.com`,
          provider: 'local',
          emailVerified: true,
          role: 'USER',
          ...(fenceStartedAt != null && { agentTriggerDeletionStartedAt: fenceStartedAt }),
          createdAt: START,
          updatedAt: START,
        },
      ]);
    },
    rewrite,
    async patchDelivery(keyOrId, patch) {
      await rewrite((collections) => {
        const record = collections[DELIVERIES].find(
          (row) => row.deliveryKey === keyOrId || row._id === keyOrId,
        );
        if (record == null) {
          throw new Error(`No delivery ${keyOrId} to patch`);
        }
        applyPatch(record, typeof patch === 'function' ? patch({ ...record }) : patch);
      });
    },
    async dropRaw(name, drop) {
      await rewrite((collections) => {
        collections[name] = collections[name].filter((record) => !drop(record));
      });
    },
  };
}
