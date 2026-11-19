import { pickStore } from './pickStore';

describe('pickStore', () => {
  let calls = 0;
  const methods = {
    read: () => calls,
    write: () => {
      calls += 1;
    },
    hidden: () => 'outside the port',
  };

  it('copies exactly the named methods', () => {
    const store = pickStore(methods, ['read', 'write'] as const);
    expect(Object.keys(store).sort()).toEqual(['read', 'write']);
    expect(store).not.toHaveProperty('hidden');
  });

  it('hands out the instance functions, sharing their state', () => {
    const store = pickStore(methods, ['read', 'write'] as const);
    expect(store.read).toBe(methods.read);
    store.write();
    expect(methods.read()).toBe(1);
  });
});
