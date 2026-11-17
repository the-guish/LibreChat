const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDataStore } = require('@librechat/data-schemas/testing');

jest.mock('@librechat/agents', () => ({
  sleep: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  prepareToolCallPreviews: jest.fn(() => (messages) => Promise.resolve(messages)),
  createToolCallPartHandler: jest.fn(() => (_req, res) => res.status(404).end()),
  createSubagentAttachmentCallsHandler: jest.fn(() => (_req, res) => res.status(404).end()),
  rejectToolCallPreviewWrites: (_req, _res, next) => next(),
  withMessageToolCallPreviews: (_req, message) => message,
  createPrivateTextView: jest.fn(() => (_req, _res, next) => next()),
  createContentFilter: jest.fn(() => (req, res, next) => next()),
  inspectContent: jest.fn(() => null),
  extractFeedbackContent: jest.fn(() => []),
  extractStoredMessageContent: jest.fn(() => []),
  contentFilterBlockResponse: jest.fn(),
  unescapeLaTeX: jest.fn((x) => x),
  countTokens: jest.fn().mockResolvedValue(10),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
  CHILD_THREAD_READ_ONLY_ERROR: 'Child thread is view-only.',
  isSubagentThreadWriteBlocked: jest.fn().mockResolvedValue(false),
  requireFeedbackEnabled: (req, res, next) => next(),
}));

jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/models', () => ({
  saveConvo: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

jest.mock('~/server/middleware', () => {
  const validateMessageReq = jest.fn((req, res, next) => next());
  const prepareMessageRequestValidation = jest.fn((req, res, next) => {
    req.messageRequestValidation = {
      conversationId: 'convo-1',
      shouldFetchMessages: true,
      promise: Promise.resolve({ ok: true }),
    };
    next();
  });
  const sendValidationResponse = jest.fn((res, result) => {
    if (result.send) {
      return res.status(result.status).send(result.body);
    }
    return res.status(result.status).json(result.body);
  });

  return {
    requireJwtAuth: (req, res, next) => next(),
    validateMessageReq,
    sendValidationResponse,
    prepareMessageRequestValidation,
    configMiddleware: (req, res, next) => next(),
  };
});

jest.mock('~/db/models', () => ({
  Message: {
    findOne: jest.fn(),
    find: jest.fn(),
    meiliSearch: jest.fn(),
  },
}));

/* ─── Model-level tests: real database, proves cross-user deletion is prevented ─── */

/**
 * The message store's `deleteMessages`, which the route calls with the filter it builds, on the
 * test data store (the backend `DATABASE_BACKEND` selects). Messages are seeded and read back
 * in raw mode, bypassing the store.
 */
describe('deleteMessages – model-level IDOR prevention', () => {
  let store;

  const ownerUserId = 'user-owner-111';
  const attackerUserId = 'user-attacker-222';

  /** Seeds `messages`, each with a new id. */
  const seedMessages = (messages) =>
    store.seed(
      'messages',
      messages.map((message) => ({ _id: store.ids.generate(), ...message })),
    );
  const findMessages = async (match) =>
    (await store.read('messages')).filter((message) =>
      Object.entries(match).every(([key, value]) => message[key] === value),
    );

  beforeAll(async () => {
    store = await createTestDataStore();
  }, 180000);

  afterAll(async () => {
    await store?.close();
  }, 60000);

  beforeEach(async () => {
    await store.reset();
  });

  it("should NOT delete another user's message when attacker supplies victim messageId", async () => {
    const conversationId = uuidv4();
    const victimMsgId = 'victim-msg-001';

    await seedMessages([
      {
        messageId: victimMsgId,
        conversationId,
        user: ownerUserId,
        text: 'Sensitive owner data',
      },
    ]);

    await store.methods.deleteMessages({ messageId: victimMsgId, user: attackerUserId });

    const [victimMsg] = await findMessages({ messageId: victimMsgId });
    expect(victimMsg).toBeDefined();
    expect(victimMsg.user).toBe(ownerUserId);
    expect(victimMsg.text).toBe('Sensitive owner data');
  });

  it("should delete the user's own message", async () => {
    const conversationId = uuidv4();
    const ownMsgId = 'own-msg-001';

    await seedMessages([
      {
        messageId: ownMsgId,
        conversationId,
        user: ownerUserId,
        text: 'My message',
      },
    ]);

    const result = await store.methods.deleteMessages({ messageId: ownMsgId, user: ownerUserId });
    expect(result.deletedCount).toBe(1);

    const deleted = await findMessages({ messageId: ownMsgId });
    expect(deleted).toEqual([]);
  });

  it('should scope deletion by conversationId, messageId, and user together', async () => {
    const convoA = uuidv4();
    const convoB = uuidv4();

    await seedMessages([
      { messageId: 'msg-a1', conversationId: convoA, user: ownerUserId, text: 'A1' },
      { messageId: 'msg-b1', conversationId: convoB, user: ownerUserId, text: 'B1' },
    ]);

    await store.methods.deleteMessages({
      messageId: 'msg-a1',
      conversationId: convoA,
      user: attackerUserId,
    });

    const remaining = await findMessages({ user: ownerUserId });
    expect(remaining).toHaveLength(2);
  });
});

/* ─── Route-level tests: supertest + mocked deleteMessages ─── */

describe('DELETE /:conversationId/:messageId – route handler', () => {
  let app;
  const { deleteMessages } = require('~/models');

  const authenticatedUserId = 'user-owner-123';

  beforeAll(() => {
    const messagesRouter = require('../messages');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: authenticatedUserId };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should pass user and conversationId in the deleteMessages filter', async () => {
    deleteMessages.mockResolvedValue({ deletedCount: 1 });

    await request(app).delete('/api/messages/convo-1/msg-1');

    expect(deleteMessages).toHaveBeenCalledTimes(1);
    expect(deleteMessages).toHaveBeenCalledWith({
      messageId: 'msg-1',
      conversationId: 'convo-1',
      user: authenticatedUserId,
    });
  });

  it('should return 204 on successful deletion', async () => {
    deleteMessages.mockResolvedValue({ deletedCount: 1 });

    const response = await request(app).delete('/api/messages/convo-1/msg-owned');

    expect(response.status).toBe(204);
    expect(deleteMessages).toHaveBeenCalledWith({
      messageId: 'msg-owned',
      conversationId: 'convo-1',
      user: authenticatedUserId,
    });
  });

  it('should return 500 when deleteMessages throws', async () => {
    deleteMessages.mockRejectedValue(new Error('DB failure'));

    const response = await request(app).delete('/api/messages/convo-1/msg-1');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});
