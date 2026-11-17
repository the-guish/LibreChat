import type { FilterQuery, Model } from 'mongoose';
import type {
  IMessage,
  IConversation,
  SubagentContentHead,
  SubagentContentScope,
  SubagentContentBatch,
  SubagentContentAppendResult,
} from '~/types';
import type { ISubagentContentChunk } from '~/models/subagentContent';
import {
  subagentContentSeedFilter,
  subagentContentScopeFilter,
  subagentContentThreadFilter,
  subagentContentParentFilter,
  subagentContentBatchRecords,
  decodeSubagentContentRecords,
  validateSubagentContentBatch,
} from './subagentContentRules';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { activeExpirationFilter } from '~/utils/retention';

export type {
  SubagentContentHead,
  SubagentContentScope,
  SubagentContentBatch,
  SubagentContentAppendResult,
} from '~/types/subagentContent';

/** Moved to the shared rules (`./subagentContentRules`); re-exported here unchanged. */
export { fragmentSubagentContent } from './subagentContentRules';

const scopeFilter = subagentContentScopeFilter;

/** Preserve source/topology records when erasure fails, and fence admitted appends first. */
export async function prepareSubagentContentDeletion(
  mongoose: typeof import('mongoose'),
  filter: Pick<FilterQuery<IMessage>, 'user' | 'tenantId' | 'conversationId'>,
): Promise<void> {
  const Content = mongoose.models.SubagentContent as Model<ISubagentContentChunk> | undefined;
  if (Content == null) return;
  const Message = mongoose.models.Message as Model<IMessage>;
  await Message.updateMany(
    { ...filter, 'subagentContent.version': 1 },
    { $set: { 'subagentContent.deleted': true } },
  );
  await Content.deleteMany(filter);
}

export function createSubagentContentMethods(mongoose: typeof import('mongoose')): {
  appendSubagentContentBatch: (
    input: SubagentContentScope & SubagentContentBatch & { leaseToken?: string },
  ) => Promise<SubagentContentAppendResult>;
  reconcileSubagentContent: (scope: SubagentContentScope) => Promise<SubagentContentAppendResult>;
  getSubagentContentHead: (
    scope: SubagentContentScope,
    throughRevision?: number,
  ) => Promise<SubagentContentHead | null>;
  streamSubagentContentBatches: (
    scope: SubagentContentScope,
    throughRevision: number,
    afterSequence?: number,
  ) => AsyncIterable<SubagentContentBatch>;
} {
  const contentModel = () => mongoose.models.SubagentContent as Model<ISubagentContentChunk>;

  async function appendSubagentContentBatch(
    input: SubagentContentScope & SubagentContentBatch & { leaseToken?: string },
  ): Promise<SubagentContentAppendResult> {
    const { revision, fromSequence, throughSequence, eventsJson, leaseToken, ...scope } = input;
    validateSubagentContentBatch({ revision, fromSequence, throughSequence });
    const Message = mongoose.models.Message as Model<IMessage>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const [seed, parent, child] = await Promise.all([
      Message.findOne(subagentContentSeedFilter(scope))
        .select('expiredAt')
        .lean<Pick<IMessage, 'expiredAt'>>(),
      Conversation.exists(subagentContentParentFilter(scope)),
      Conversation.exists(subagentContentThreadFilter(scope, { leaseToken })),
    ]);
    if (seed == null || parent == null || child == null) {
      await reconcileSubagentContent(scope);
      return { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } };
    }
    const Model = contentModel();
    const { digest, fragments, commit } = subagentContentBatchRecords(
      scope,
      { revision, fromSequence, throughSequence, eventsJson },
      seed.expiredAt,
    );
    const records = fragments.map(({ _id, ...record }) => ({
      updateOne: {
        filter: { _id, ...scopeFilter(scope), revision, fragment: record.fragment, digest },
        update: { $setOnInsert: record },
        upsert: true,
      },
    }));
    await tenantSafeBulkWrite(Model, records, { ordered: false });
    /** A retry can only commit identical bytes; conflicting retries hit the unique index. */
    const { _id: commitId, ...commitRecord } = commit;
    await Model.updateOne(
      { _id: commitId, ...scopeFilter(scope), revision, fragment: -1, digest },
      { $setOnInsert: commitRecord },
      { upsert: true },
    );
    return reconcileSubagentContent(scope);
  }

  /** Cleanup never replays payloads or requires a live execution lease. */
  async function reconcileSubagentContent(
    scope: SubagentContentScope,
  ): Promise<SubagentContentAppendResult> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const [seed, parent, child] = await Promise.all([
      Message.exists(subagentContentSeedFilter(scope)),
      Conversation.exists(subagentContentParentFilter(scope)),
      Conversation.exists(subagentContentThreadFilter(scope)),
    ]);
    if (seed == null || parent == null || child == null) {
      await contentModel().deleteMany(scopeFilter(scope));
      return { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } };
    }
    return { ok: true };
  }

  async function getSubagentContentHead(
    scope: SubagentContentScope,
    throughRevision?: number,
  ): Promise<SubagentContentHead | null> {
    return contentModel()
      .findOne({
        ...scopeFilter(scope),
        fragment: -1,
        ...(throughRevision == null ? {} : { revision: { $lte: throughRevision } }),
        ...activeExpirationFilter(),
      })
      .sort({ revision: -1 })
      .select('revision throughSequence -_id')
      .lean<SubagentContentHead>();
  }

  async function* streamSubagentContentBatches(
    scope: SubagentContentScope,
    throughRevision: number,
    afterSequence = -1,
  ): AsyncGenerator<SubagentContentBatch> {
    if (throughRevision < 1) return;
    const Model = contentModel();
    let fromRevision = 1;
    if (afterSequence >= 0) {
      /** Commit sequences increase with revisions. Seek without a revision predicate so
       * an exhausted pin cannot scan later commits looking for an older revision. */
      const first = await Model.findOne({
        ...scopeFilter(scope),
        fragment: -1,
        throughSequence: { $gt: afterSequence },
        ...activeExpirationFilter(),
      })
        .sort({ throughSequence: 1 })
        .select('revision -_id')
        .lean<Pick<SubagentContentHead, 'revision'>>();
      if (first == null || first.revision > throughRevision) return;
      fromRevision = first.revision;
    }
    const cursor = Model.find({
      ...scopeFilter(scope),
      revision: { $gte: fromRevision, $lte: throughRevision },
      ...activeExpirationFilter(),
    })
      .sort({ revision: 1, fragment: 1 })
      .lean()
      .cursor();
    try {
      yield* decodeSubagentContentRecords(cursor);
    } finally {
      await cursor.close();
    }
  }

  return {
    appendSubagentContentBatch,
    reconcileSubagentContent,
    getSubagentContentHead,
    streamSubagentContentBatches,
  };
}

export type SubagentContentMethods = ReturnType<typeof createSubagentContentMethods>;
