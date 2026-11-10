/**
 * Builds a store from an existing MongoDB methods instance: the store hands out the instance's
 * own functions, by name, rather than a second instance's. The methods of one instance share
 * per-instance state (cached index builds, late-bound dependencies), and the methods a port
 * leaves out must keep working through the same instance the port serves.
 *
 * Every name must be a method of `methods`, and the result must be assignable to the store type
 * the caller declares, so a port method the instance lacks, or one whose signature it does not
 * satisfy, is a compile error at the call.
 */
export function pickStore<Methods extends object, Name extends keyof Methods>(
  methods: Methods,
  names: ReadonlyArray<Name>,
): Pick<Methods, Name> {
  const store: Partial<Pick<Methods, Name>> = {};
  for (const name of names) {
    store[name] = methods[name];
  }
  return store as Pick<Methods, Name>;
}
