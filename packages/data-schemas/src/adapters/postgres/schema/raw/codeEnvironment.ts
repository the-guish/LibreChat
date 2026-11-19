/**
 * The code environments' raw collections (`methods/codeEnvironment.ts`), declared for the
 * PostgreSQL mapping only (docs/postgres-port/PHASE4.md §1.4, §1.6): never registered as models.
 */
import { Schema } from 'mongoose';

/** `code_environment_tombstones`: retired environment and setup ids (`CodeEnvironmentTombstone`). */
export const codeEnvironmentTombstoneSchema: Schema = new Schema(
  {
    _id: { type: String },
    tenantId: String,
    environmentId: String,
    deletedAt: Date,
    setupBinding: String,
    setupResourceId: String,
  },
  { versionKey: false },
);

/**
 * `code_environment_reconciliation`: the progress of the agent reference sweep
 * (`CodeEnvironmentReconciliationCheckpoint`).
 */
export const codeEnvironmentReconciliationSchema: Schema = new Schema(
  {
    _id: { type: String },
    lastId: Schema.Types.ObjectId,
    upperId: Schema.Types.ObjectId,
  },
  { versionKey: false },
);
