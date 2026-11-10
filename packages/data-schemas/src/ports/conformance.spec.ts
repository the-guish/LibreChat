import type { DeleteResult } from 'mongodb';
import type { Types } from 'mongoose';
import type {
  Assert,
  Equals,
  EveryMethodPlaced,
  ExclusionsHold,
  SameSignatures,
  Satisfies,
} from './conformance';
import type { DeleteCount, IdLike } from './common';
import { listPortMethods } from './common';

/*
 * The conformance checks themselves, on a made-up module: a port that states a MongoDB signature
 * in neutral types (`IdLike`, `DeleteCount`), and the module's methods behind it.
 */
interface ThingStore {
  getThing(id: IdLike): Promise<{ name: string } | null>;
  removeThing(id: IdLike): Promise<DeleteCount>;
}
interface ThingMethods {
  getThing: (id: string | Types.ObjectId) => Promise<{ name: string } | null>;
  removeThing: (id: string | Types.ObjectId) => Promise<DeleteResult>;
  /** Takes a raw MongoDB filter, so it stays out of the port. */
  findThings: (filter: Record<string, unknown>) => Promise<Array<{ name: string }>>;
}
type Excluded = 'findThings';

type Positive = [
  /** The MongoDB methods satisfy the neutral port... */
  Assert<Satisfies<ThingStore, ThingMethods>>,
  /** ...although their signatures differ from it. */
  Assert<Equals<SameSignatures<ThingStore, ThingMethods>, false>>,
  Assert<EveryMethodPlaced<ThingStore, ThingMethods, Excluded>>,
  Assert<ExclusionsHold<ThingStore, Excluded>>,
  /** A verbatim port has the same signatures. */
  Assert<SameSignatures<Pick<ThingMethods, 'getThing'>, ThingMethods>>,
];

type Negative = [
  /** A missing method does not satisfy the port. */
  Equals<Satisfies<ThingStore, Omit<ThingMethods, 'removeThing'>>, false>,
  /** Nor does a result the port's result type does not cover. */
  Equals<
    Satisfies<
      ThingStore,
      Omit<ThingMethods, 'removeThing'> & { removeThing: (id: string) => Promise<number> }
    >,
    false
  >,
  /** An unlisted method is not placed. */
  Equals<EveryMethodPlaced<ThingStore, ThingMethods, never>, false>,
  /** An excluded method that is in the port breaks the exclusion. */
  Equals<ExclusionsHold<ThingStore, 'getThing'>, false>,
];

describe('port conformance checks', () => {
  it('accept a conforming module and reject drift at the type level', () => {
    const positive: Positive = [true, true, true, true, true];
    const negative: Negative = [true, true, true, true];
    expect([...positive, ...negative].every(Boolean)).toBe(true);
  });

  it('list the port methods from a full key set', () => {
    const names = listPortMethods<ThingStore>({ getThing: true, removeThing: true });
    expect(names).toEqual(['getThing', 'removeThing']);
  });
});
