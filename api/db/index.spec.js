describe('api/db/index.js', () => {
  test('the models are registered before indexSync is loaded', () => {
    jest.resetModules();

    const callOrder = [];

    /**
     * The models are registered either with `createModels(mongoose)` or through the data store
     * backend (`getDataStoreBackend().registerModels()`); both are recorded the same way.
     */
    jest.mock('@librechat/data-schemas', () => ({
      createModels: jest.fn((m) => {
        callOrder.push('registerModels');
        m.models.Message = { name: 'Message' };
        m.models.Conversation = { name: 'Conversation' };
      }),
      getDataStoreBackend: jest.fn(() => ({
        registerModels: jest.fn(() => {
          callOrder.push('registerModels');
        }),
      })),
    }));

    jest.mock('./indexSync', () => {
      callOrder.push('indexSync');
      return jest.fn();
    });

    jest.mock('./connect', () => ({ connectDb: jest.fn() }));

    require('./index');

    expect(callOrder).toEqual(['registerModels', 'indexSync']);
  });
});
