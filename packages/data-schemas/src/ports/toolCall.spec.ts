import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { ToolCallMethods } from '~/methods/toolCall';
import type { ToolCallStore } from './toolCall';
import { createToolCallMethods } from '~/methods/toolCall';
import { TOOL_CALL_STORE_METHODS } from './toolCall';

/**
 * Tool call methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for the driver's `DeleteResult`, stated as `DeleteCount`,
 * and lean read rows typed with mongoose's `FlattenMaps`, stated as plain `ToolCallRecord`s.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<ToolCallStore, ToolCallMethods>>,
  Assert<EveryMethodPlaced<ToolCallStore, ToolCallMethods, Excluded>>,
  Assert<ExclusionsHold<ToolCallStore, Excluded>>,
];

describe('ToolCallStore port', () => {
  const methods = createToolCallMethods(mongoose);

  it('matches the MongoDB tool call methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(TOOL_CALL_STORE_METHODS).size).toBe(TOOL_CALL_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...TOOL_CALL_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB tool call methods', () => {
    const store: ToolCallStore = methods;
    for (const name of TOOL_CALL_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
