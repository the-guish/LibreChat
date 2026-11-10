import mongoose from 'mongoose';
import type {
  Assert,
  EveryMethodPlaced,
  ExclusionsHold,
  SameSignatures,
  Satisfies,
} from './conformance';
import type { MessageMethods } from '~/methods/message';
import type { MessageStore } from './message';
import { createMessageMethods } from '~/methods/message';
import { MESSAGE_STORE_METHODS } from './message';

/**
 * Message methods left out of the port, each with the reason:
 * - `getMessages`: takes a raw MongoDB filter (`FilterQuery<IMessage>`), a projection string and
 *   sort/limit options.
 * - `getMessagesByCursor`: takes a raw MongoDB filter, and its options carry a projection
 *   string and a sort field.
 * - `deleteMessages`: takes a raw MongoDB filter and resolves the driver's `DeleteResult`.
 * - `searchMessages`: takes MeiliSearch `SearchParams` (a filter in MeiliSearch's syntax) and
 *   resolves MeiliSearch's `SearchResponse`, through the MongoDB model's meilisearch plugin.
 *
 * The other methods' signatures are copied verbatim, but for `listSubagentTasksForThreads`,
 * whose records the port states without the MongoDB ordering token (`occurrenceId`).
 */
const EXCLUDED = [
  'getMessages',
  'getMessagesByCursor',
  'deleteMessages',
  'searchMessages',
] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<MessageStore, MessageMethods>>,
  Assert<SameSignatures<Omit<MessageStore, 'listSubagentTasksForThreads'>, MessageMethods>>,
  Assert<EveryMethodPlaced<MessageStore, MessageMethods, Excluded>>,
  Assert<ExclusionsHold<MessageStore, Excluded>>,
];

describe('MessageStore port', () => {
  const methods = createMessageMethods(mongoose);

  it('matches the MongoDB message methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(MESSAGE_STORE_METHODS).size).toBe(MESSAGE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...MESSAGE_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB message methods', () => {
    const store: MessageStore = methods;
    for (const name of MESSAGE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
