import { buildSubagentThreadTaskConfig, SubagentThreadTaskStore } from './subagentThreads';

type StoreMethods = ConstructorParameters<typeof SubagentThreadTaskStore>[0];
type ConfigOptions = NonNullable<Parameters<typeof buildSubagentThreadTaskConfig>[2]>;

/** The agent client's view of `config.store` (`api/server/controllers/agents/client.js`). */
type ParentGatedStore = {
  registerParentPersistence?: (scopeId: string, persistence: Promise<unknown>) => void;
};

/**
 * The agent client gates the first child of a turn on the parent's write by calling
 * `registerParentPersistence` on the store of the task config it holds. With completion wakeups
 * or request-scoped MCP connections, that store is the wakeup adapter, which must forward the
 * gate; otherwise a child can read its parent conversation before it is saved.
 */
describe('subagent task config: parent persistence gate', () => {
  const scope = { userId: 'gate-user', parentConversationId: 'gate-parent' };
  const cases: Array<[string, ConfigOptions]> = [
    ['the plain store', {}],
    ['completion wakeups', { completionWakeups: true }],
    ['request-scoped connections', { requestScopedConnections: {} as never }],
    [
      'request-scoped connections and wakeups',
      { completionWakeups: true, requestScopedConnections: {} as never },
    ],
  ];

  it.each(cases)('forwards the gate to the thread store with %s', (_label, options) => {
    const store = new SubagentThreadTaskStore({} as StoreMethods);
    const register = jest.spyOn(store, 'registerParentPersistence');
    const config = buildSubagentThreadTaskConfig(store, scope, options);
    const gated = config.store as unknown as ParentGatedStore;

    expect(typeof gated.registerParentPersistence).toBe('function');
    const persistence = Promise.resolve({
      message: { messageId: 'parent-message', conversationId: scope.parentConversationId },
    });
    gated.registerParentPersistence?.(config.scopeId, persistence);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(config.scopeId, persistence);
  });
});
