/**
 * Type-level conformance checks between a port and the MongoDB methods behind it, for the port
 * specs. They fail `npm run typecheck`, not Jest, when the two drift apart.
 *
 * Every port spec asserts three things:
 * - the MongoDB methods satisfy the port: {@link SameSignatures} when the port copies the method
 *   signatures verbatim, {@link Satisfies} when the port states a signature in neutral types from
 *   `./common` (an `IdLike` where the method takes `Types.ObjectId`, a `DeleteCount` where it
 *   returns the driver's `DeleteResult`);
 * - {@link EveryMethodPlaced}: every method of the module is either in the port or in the spec's
 *   exclusion list (a method whose signature takes a raw MongoDB filter, update or projection);
 * - {@link ExclusionsHold}: no excluded method is in the port.
 *
 * The runtime method list (`*_STORE_METHODS`) is typed as the port's full key set where it is
 * declared, so it cannot drift from the port either.
 */

/** `true` when `A` and `B` are the same type. */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only for `true`. */
export type Assert<T extends true> = T;

/** The methods of `Impl` that the port names, by the port's keys. */
type PortSlice<Port, Impl> = { [K in keyof Port]: K extends keyof Impl ? Impl[K] : never };

/** Every port method exists on `Impl` with exactly the same signature. */
export type SameSignatures<Port, Impl> = Equals<
  { [K in keyof Port]: Port[K] },
  PortSlice<Port, Impl>
>;

/** Every port method exists on `Impl` and `Impl`'s method is assignable to the port's. */
export type Satisfies<Port, Impl> = [PortSlice<Port, Impl>] extends [Port]
  ? Equals<Extract<keyof Port, keyof Impl>, keyof Port>
  : false;

/** Every method of `Impl` is either in the port or listed in `Excluded`. */
export type EveryMethodPlaced<Port, Impl, Excluded extends PropertyKey> = Equals<
  keyof Impl,
  keyof Port | Excluded
>;

/** No method listed in `Excluded` is in the port. */
export type ExclusionsHold<Port, Excluded extends PropertyKey> = Equals<
  Extract<keyof Port, Excluded>,
  never
>;
