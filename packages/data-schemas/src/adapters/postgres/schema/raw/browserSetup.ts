/**
 * The browser setup's raw collections (`methods/browserSetup.ts`), declared for the PostgreSQL
 * mapping only (docs/postgres-port/PHASE4.md §1.4, §1.6): never registered as models. The shapes
 * follow the documents `createBrowserSetupStore` writes (`SessionDocument`, `AllocationBudget`,
 * `RequestBudget` and `BrowserSetupSession` in `types/browserSetup.ts`), the indexes are those it
 * creates.
 */
import { Schema } from 'mongoose';

/** A field named `type` (mongoose reads a bare `type` key as the field's type). */
const typeField = { type: { type: String } } as const;

/** `BrowserSetupSession`'s fields, shared by a session document and an allocation's copy. */
const sessionFields = {
  attemptId: String,
  requestCanonical: String,
  requestHash: String,
  createdAt: String,
  expiresAt: String,
  verificationCode: String,
  workerId: String,
  status: String,
  revision: Number,
  ownerId: String,
  tenantId: String,
  planeId: String,
  baseURL: String,
  tokenEnv: String,
  approval: new Schema(
    {
      protocolVersion: Number,
      operation: String,
      serverId: String,
      instance: String,
      attemptId: String,
      requestHash: String,
      workerId: String,
      expiresAt: String,
      publicKey: String,
      binding: new Schema(
        {
          tenantId: String,
          principal: new Schema({ ...typeField, id: String }, { _id: false }),
        },
        { _id: false },
      ),
    },
    { _id: false },
  ),
  progress: new Schema(
    {
      registryReserved: Boolean,
      registryCompleted: Boolean,
      issued: Boolean,
      redemption: Boolean,
      cleanup: Boolean,
    },
    { _id: false },
  ),
  failureCode: String,
  stopReason: String,
  leaseId: String,
  leaseExpiresAt: Number,
  purgeAt: String,
};

/** `browser_setup_sessions`: one document per enrollment attempt, removed at `deleteAfter`. */
export const browserSetupSessionSchema: Schema = new Schema(
  {
    _id: { type: String },
    ...sessionFields,
    nonces: [new Schema({ nonce: String, expiresAt: Number }, { _id: false })],
    operations: Number,
    deleteAfter: Date,
    allocationReleased: Boolean,
    reconciledAt: Number,
  },
  { versionKey: false },
);
browserSetupSessionSchema.index({ deleteAfter: 1 }, { expireAfterSeconds: 0 });
browserSetupSessionSchema.index({ reconciledAt: 1, expiresAt: 1, _id: 1 });

/** `browser_setup_budget`: the singleton (`_id: 'global'`) of open allocations. */
export const browserSetupBudgetSchema: Schema = new Schema(
  {
    _id: { type: String },
    allocations: [
      new Schema(
        {
          attemptId: String,
          ipHash: String,
          expiresAt: Number,
          session: new Schema(sessionFields, { _id: false }),
        },
        { _id: false },
      ),
    ],
  },
  { versionKey: false },
);

/** `browser_setup_requests`: the singleton (`_id: 'global'`) request budget, per peer counts. */
export const browserSetupRequestSchema: Schema = new Schema(
  {
    _id: { type: String },
    expiresAt: Number,
    count: Number,
    peers: { type: Map, of: Number },
  },
  { versionKey: false },
);
