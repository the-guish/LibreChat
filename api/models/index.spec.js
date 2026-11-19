/**
 * The composition root builds the methods either with `createMethods(mongoose, deps)` or through
 * the data store backend (`getDataStoreBackend().createMethods(deps)`); both reach the same mock,
 * so `createMethods.mock.calls[0][1]` is the dependencies either way.
 */
jest.mock('@librechat/data-schemas', () => {
  const createMethods = jest.fn(() => ({}));
  return {
    createMethods,
    getDataStoreBackend: jest.fn(() => ({
      createMethods: jest.fn((deps) => createMethods(undefined, deps)),
    })),
  };
});
jest.mock('@librechat/api', () => ({
  matchModelName: jest.fn(),
  findMatchingPattern: jest.fn(),
  isDeploymentSkillId: jest.fn(),
  createMessageBudgetReader: jest.fn(() => ({ getBudget: jest.fn(), initialize: jest.fn() })),
}));
jest.mock('~/cache/getLogStores', () => jest.fn());

const { createMethods } = require('@librechat/data-schemas');
const { createMessageBudgetReader } = require('@librechat/api');
const { initializeMessageBudget } = require('./index');
const reader = createMessageBudgetReader.mock.results[0].value;
const { getMCPAppMessageBudget } = createMethods.mock.calls[0][1];

describe('message App budget dependency wiring', () => {
  it('passes the same reader to storage and initializer to the composition root', () => {
    expect(getMCPAppMessageBudget).toBe(reader.getBudget);
    expect(initializeMessageBudget).toBe(reader.initialize);
    expect(reader.getBudget).not.toHaveBeenCalled();
  });
});
