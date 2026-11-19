import type { Document, Types } from 'mongoose';

export type SkillSyncProvider = 'github';
/**
 * `partial` means the source published at least one skill while dropping some
 * of what it was asked to mirror — an unusable `SKILL.md`, or a file whose path
 * cannot be represented as a skill file path. A single bad skill must not hide
 * the ones that synced fine, and a run that quietly reported `succeeded` would
 * hide whatever it dropped.
 */
export type SkillSyncRunStatus =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'skipped';

/** One upstream skill a run could not publish, with the reason it was dropped. */
export interface ISkillSyncSkippedSkill {
  /** Repository path of the skill root that was skipped. */
  path: string;
  /** Frontmatter name, when the failure happened late enough for one to exist. */
  name?: string;
  errorCode: string;
  errorMessage: string;
}

/**
 * One upstream file a run published a skill without. Unlike a skipped skill,
 * the skill itself is live — it is just missing this file, which is invisible
 * from the mirrored copy alone and so has to be recorded here.
 */
export interface ISkillSyncSkippedFile {
  /** Repository path of the file that was dropped. */
  path: string;
  /** Repository path of the skill root it belongs to. */
  skillPath: string;
  errorCode: string;
  errorMessage: string;
}

export interface ISkillSyncCredential {
  provider: SkillSyncProvider;
  credentialKey: string;
  encryptedToken: string;
  tokenHash: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISkillSyncCredentialDocument extends ISkillSyncCredential, Document {}

export interface ISkillSyncStatus {
  provider: SkillSyncProvider;
  sourceId: string;
  tenantId?: string;
  status: SkillSyncRunStatus;
  credentialKey?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  paths?: string[];
  startedAt?: Date;
  finishedAt?: Date;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  syncedSkillCount: number;
  syncedFileCount: number;
  deletedSkillCount: number;
  deletedFileCount: number;
  skippedSkillCount: number;
  /** Capped sample of the skipped skills; `skippedSkillCount` is the full total. */
  skippedSkills?: ISkillSyncSkippedSkill[];
  skippedFileCount: number;
  /** Capped sample of the skipped files; `skippedFileCount` is the full total. */
  skippedFiles?: ISkillSyncSkippedFile[];
  lockOwner?: string;
  lockExpiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISkillSyncStatusDocument extends ISkillSyncStatus, Document {}

/** A stored sync credential as callers see it: never the token, only a fingerprint of it. */
export type SkillSyncCredentialSummary = {
  provider: SkillSyncProvider;
  credentialKey: string;
  credentialPresent: boolean;
  tokenFingerprint?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

/** A sync credential to create or replace; `userId` is the admin who writes it. */
export type UpsertSkillSyncCredentialInput = {
  provider: SkillSyncProvider;
  credentialKey: string;
  token: string;
  userId?: Types.ObjectId;
};

/** The outcome of one sync run of a source, recorded on the source's status. */
export type SkillSyncStatusInput = {
  provider: SkillSyncProvider;
  sourceId: string;
  tenantId?: string;
  status: SkillSyncRunStatus;
  credentialKey?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  paths?: string[];
  startedAt?: Date;
  finishedAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  syncedSkillCount?: number;
  syncedFileCount?: number;
  deletedSkillCount?: number;
  deletedFileCount?: number;
  skippedSkillCount?: number;
  skippedSkills?: ISkillSyncSkippedSkill[];
  skippedFileCount?: number;
  skippedFiles?: ISkillSyncSkippedFile[];
};

/** A claim on the provider's sync lock (per tenant) for `leaseMs`. */
export type SkillSyncLockInput = {
  provider: SkillSyncProvider;
  lockOwner: string;
  leaseMs: number;
  tenantId?: string;
};

/** Gives up the provider's sync lock held by `lockOwner`. */
export type SkillSyncReleaseLockInput = {
  provider: SkillSyncProvider;
  lockOwner: string;
  tenantId?: string;
};
