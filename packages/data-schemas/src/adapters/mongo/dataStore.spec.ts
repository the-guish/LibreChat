import mongoose from 'mongoose';
import type { DataStore } from '~/ports';
import { DATA_STORE_METHODS } from '~/ports';
import { createMethods } from '~/methods';

describe('createMongoDataStore (through createMethods)', () => {
  const methods = createMethods(mongoose);
  const storeNames = Object.keys(DATA_STORE_METHODS) as Array<keyof DataStore>;

  it('holds one store per port', () => {
    expect(Object.keys(methods.stores).sort()).toEqual([...storeNames].sort());
  });

  it('exposes exactly the port methods on each store', () => {
    for (const storeName of storeNames) {
      expect(Object.keys(methods.stores[storeName]).sort()).toEqual(
        [...DATA_STORE_METHODS[storeName]].sort(),
      );
    }
  });

  it('hands out the same functions as the flat methods, so one instance serves both', () => {
    for (const storeName of storeNames) {
      const store = methods.stores[storeName] as unknown as Record<string, unknown>;
      for (const name of DATA_STORE_METHODS[storeName] as ReadonlyArray<string>) {
        expect(typeof store[name]).toBe('function');
        expect(store[name]).toBe((methods as unknown as Record<string, unknown>)[name]);
      }
    }
  });

  it('gives no two stores the same method name', () => {
    const names = storeNames.flatMap(
      (storeName) => DATA_STORE_METHODS[storeName] as ReadonlyArray<string>,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the conversation store at the top level', () => {
    expect(methods.conversations).toBe(methods.stores.conversations);
  });
});
