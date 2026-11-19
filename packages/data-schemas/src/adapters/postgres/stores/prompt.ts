/**
 * The PostgreSQL `PromptLibraryStore` (`~/ports/promptLibrary`): prompt groups (`promptgroups`)
 * and their prompts (`prompts`), through the collection primitive, with the listing criteria,
 * cursors, pages and access sets of `~/methods/promptRules`. Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * - **Production prompts** are joined in JavaScript, as MongoDB's reads do: the listings read
 *   the groups' production prompts (their text) in one batched `_id IN` read, scoped to the
 *   active tenant like the groups; `getPromptGroup` reads the group (tenant-scoped, as the plugin
 *   scopes the aggregation's `$match`) and then its production prompt by id in raw mode (any
 *   tenant, every stored field, as `$lookup` returns it), hiding one of another tenant.
 * - **Listings** keep MongoDB's order (use count, update time, id) and its keyset cursor; the name
 *   search is the escaped, case-insensitive regex of the rules (ICU case folding, §2.4).
 * - **`createPromptGroup`** reuses an unfinished native group through the primitive's upsert on
 *   the same filter (`productionId: null`, `source` native or missing), then upserts the prompt and
 *   points the group at it, as on MongoDB (three writes, no transaction).
 * - **`deleteUserPrompts`** reads and deletes the ACL entries of the legacy groups through the
 *   `aclentries` collection (tenant-scoped, as the MongoDB method's model reads are).
 * - The access sets and their tenant-generation cache are the rules' (shared module state, as on
 *   MongoDB), with the store's ids (hex strings) revived as they are.
 */
import { ResourceType, PromptGroupSources } from 'librechat-data-provider';
import type { PromptLibraryStore } from '~/ports/promptLibrary';
import type { PromptFactoryDeps } from '~/compose/types';
import type { PgFilter, PgRecord } from '../collection';
import type { PostgresStoreContext } from './context';
import type { IdLike } from '~/ports/common';
import {
  PROMPT_GROUP_LIST_SORT,
  PROMPT_GROUP_LIST_FIELDS,
  PROMPT_GROUP_ALL_LIST_FIELDS,
  promptGroupPage,
  promptGroupListPage,
  promptGroupListLimit,
  createPromptGroupAccess,
  parsePromptGroupCursor,
  promptGroupCursorCondition,
  applyPromptGroupListCriteria,
} from '~/methods/promptRules';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { isValidObjectIdString } from '~/utils/objectId';
import logger from '~/config/winston';

type GroupRecord = PgRecord & { _id: string; productionId?: string | null; author?: string };
type PromptRecord = PgRecord & { _id: string; prompt?: string; tenantId?: string };
type PromptResult = Awaited<ReturnType<PromptLibraryStore['savePrompt']>>['prompt'];
type GroupResult = Awaited<ReturnType<PromptLibraryStore['updatePromptGroup']>>;

export function createPostgresPromptStore(
  context: PostgresStoreContext,
  deps: PromptFactoryDeps,
): PromptLibraryStore {
  const groups = () => context.collections().collection<GroupRecord>('promptgroups');
  const prompts = () => context.collections().collection<PromptRecord>('prompts');
  const acl = () => context.collections().collection('aclentries');
  const asPrompt = (record: PgRecord | null) => record as unknown as PromptResult;

  async function getOwnedPromptGroupIds(author: string, _readPrimary = false): Promise<IdLike[]> {
    try {
      if (!author || !isValidObjectIdString(author)) {
        logger.warn('getOwnedPromptGroupIds called with invalid author', { author });
        return [];
      }
      const owned = await groups().find({ author }, { projection: '_id' });
      return owned.map((group) => group._id);
    } catch (error) {
      logger.error('Error getting owned prompt group IDs', error);
      /** A failed lookup must not be cached as an empty ownership set */
      throw error;
    }
  }

  const { getPromptGroupAccessContext, invalidatePromptGroupAccessContext } =
    createPromptGroupAccess({
      getCache: (key) => deps.getCache?.(key),
      getUserPrincipals: deps.getUserPrincipals,
      findAccessibleResources: deps.findAccessibleResources,
      findPublicResourceIds: deps.findPublicResourceIds,
      getOwnedPromptGroupIds,
      reviveId: (id): IdLike => id,
    });

  /** Each group with its production prompt (`_id` and text, of the active tenant) attached. */
  async function attachProductionPrompts(
    rows: GroupRecord[],
  ): Promise<Array<Record<string, unknown>>> {
    const uniqueIds = [...new Set(rows.map((group) => group.productionId).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return rows.map((group) => ({ ...group, productionPrompt: null }));
    }
    const found = await prompts().find({ _id: { $in: uniqueIds } }, { projection: 'prompt' });
    const byId = new Map(found.map((prompt) => [prompt._id, prompt]));
    return rows.map((group) => ({
      ...group,
      productionPrompt: group.productionId ? (byId.get(group.productionId) ?? null) : null,
    }));
  }

  const store: PromptLibraryStore = {
    async getPromptGroups(filter) {
      try {
        const { pageNumber = 1, pageSize = 10, name, ...query } = filter;
        const page = promptGroupPage(pageNumber, pageSize);
        const criteria = applyPromptGroupListCriteria(query, name) as PgFilter;
        const [rows, total] = await Promise.all([
          groups().find(criteria, {
            sort: PROMPT_GROUP_LIST_SORT,
            skip: page.skip,
            limit: page.limit,
            projection: PROMPT_GROUP_LIST_FIELDS,
          }),
          groups().count(criteria),
        ]);
        return {
          promptGroups: await attachProductionPrompts(rows),
          pageNumber: page.pageNumber.toString(),
          pageSize: page.pageSize.toString(),
          pages: Math.ceil(total / page.pageSize).toString(),
        };
      } catch (error) {
        logger.error('Error getting prompt groups', error);
        return { message: 'Error getting prompt groups' };
      }
    },

    async getAllPromptGroups(filter) {
      try {
        const { name, ...query } = filter;
        const rows = await groups().find(applyPromptGroupListCriteria(query, name) as PgFilter, {
          sort: PROMPT_GROUP_LIST_SORT,
          projection: PROMPT_GROUP_ALL_LIST_FIELDS,
        });
        return await attachProductionPrompts(rows);
      } catch (error) {
        logger.error('Error getting all prompt groups', error);
        return { message: 'Error getting all prompt groups' };
      }
    },

    async getPromptGroup(filter) {
      const group = await groups().findOne(filter);
      if (!group) {
        return null;
      }
      const result: Record<string, unknown> = { ...group };
      const production =
        group.productionId != null
          ? await context.collections().raw('prompts').findOne({ _id: group.productionId })
          : null;
      if (production) {
        const tenantId = getTenantId();
        const useTenantFilter = tenantId && tenantId !== SYSTEM_TENANT_ID;
        result.productionPrompt =
          useTenantFilter && production.tenantId !== tenantId ? null : production;
      }
      if (result.author) {
        result.author = String(result.author);
      }
      return result;
    },

    async updatePromptGroup(filter, data) {
      const updated = await groups().findOneAndUpdate(filter, data, { returnDocument: 'after' });
      if (!updated) {
        throw new Error('Prompt group not found');
      }
      return updated as unknown as GroupResult;
    },

    /**
     * Newest first. `_id` breaks `createdAt` ties: two revisions saved in the same millisecond
     * would otherwise come back in either order (PostgreSQL keeps no insertion order), and callers
     * number revisions by position. Store ids rise within a process, as ObjectIds do.
     */
    async getPrompts(filter) {
      const rows = await prompts().find(filter, { sort: { createdAt: -1, _id: -1 } });
      return rows as unknown as PromptResult[];
    },

    async getPrompt(filter) {
      return asPrompt(await prompts().findOne(filter));
    },

    /** Authorization is enforced upstream: this deletes any group by id. */
    async deletePromptGroup({ _id }) {
      const response = await groups().deleteOne({ _id });
      if (response.deletedCount === 0) {
        throw new Error('Prompt group not found');
      }
      await prompts().deleteMany({ groupId: _id });
      try {
        await deps.removeAllPermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: _id,
        });
      } catch (error) {
        logger.error('Error removing promptGroup permissions:', error);
      }
      await invalidatePromptGroupAccessContext();
      return { message: 'Prompt group deleted successfully' };
    },

    async getListPromptGroupsByAccess({
      accessibleIds = [],
      name,
      category,
      limit = null,
      after = null,
    }) {
      const normalizedLimit = promptGroupListLimit(limit);
      const baseQuery: Record<string, unknown> = { _id: { $in: accessibleIds } };
      applyPromptGroupListCriteria(baseQuery, name);
      if (category != null) {
        baseQuery.category = category;
      }
      const cursor = parsePromptGroupCursor(after);
      const matchQuery = cursor
        ? { $and: [baseQuery, promptGroupCursorCondition(cursor, (id) => id)] }
        : baseQuery;
      const rows = await groups().find(matchQuery, {
        sort: PROMPT_GROUP_LIST_SORT,
        projection: PROMPT_GROUP_LIST_FIELDS,
        ...(normalizedLimit ? { limit: normalizedLimit + 1 } : {}),
      });
      return promptGroupListPage(await attachProductionPrompts(rows), normalizedLimit);
    },

    async incrementPromptGroupUsage(groupId) {
      if (!isValidObjectIdString(groupId)) {
        throw new Error('Invalid groupId');
      }
      const result = await groups().findOneAndUpdate(
        { _id: groupId },
        { $inc: { numberOfGenerations: 1 } },
        { returnDocument: 'after', projection: 'numberOfGenerations' },
      );
      if (!result) {
        throw new Error('Prompt group not found');
      }
      return { numberOfGenerations: result.numberOfGenerations as number };
    },

    async createPromptGroup({ prompt, group, author, authorName }) {
      try {
        /**
         * Only reuse native groups, including legacy groups with no source. Mirrored
         * groups can also lack a productionId, but must not receive a native prompt.
         */
        const reused = await groups().findOneAndUpdate(
          {
            ...group,
            author,
            authorName,
            productionId: null,
            source: { $in: [PromptGroupSources.native, null] },
          },
          { $setOnInsert: { ...group, author, authorName, productionId: null } },
          { upsert: true, returnDocument: 'after', projection: '-__v' },
        );
        const groupId = (reused as GroupRecord)._id;
        const newPrompt = await prompts().findOneAndUpdate(
          { ...prompt, author, groupId },
          { $setOnInsert: { ...prompt, author, groupId } },
          { upsert: true, returnDocument: 'after', projection: '-__v' },
        );
        const newPromptGroup = await groups().findOneAndUpdate(
          { _id: groupId },
          { productionId: (newPrompt as PromptRecord)._id },
          { returnDocument: 'after', projection: '-__v' },
        );
        await invalidatePromptGroupAccessContext();
        return {
          prompt: newPrompt,
          group: {
            ...newPromptGroup,
            productionPrompt: { prompt: (newPrompt as PromptRecord).prompt },
          },
        };
      } catch (error) {
        logger.error('Error saving prompt group', error);
        throw new Error('Error saving prompt group');
      }
    },

    async savePrompt({ prompt, author }) {
      const created = await prompts().insertOne({ ...prompt, author });
      return { prompt: asPrompt(created) };
    },

    getOwnedPromptGroupIds,
    getPromptGroupAccessContext,
    invalidatePromptGroupAccessContext,

    /** Authorization is enforced upstream: this deletes any prompt by id. */
    async deletePrompt({ promptId, groupId }) {
      const { deletedCount } = await prompts().deleteOne({ _id: promptId, groupId });
      if (deletedCount === 0) {
        throw new Error('Failed to delete the prompt');
      }
      /** Oldest first; ids break creation-time ties in insertion order (R7). */
      const remainingPrompts = await prompts().find(
        { groupId },
        { projection: '_id', sort: { createdAt: 1, _id: 1 } },
      );
      if (remainingPrompts.length === 0) {
        try {
          await deps.removeAllPermissions({
            resourceType: ResourceType.PROMPTGROUP,
            resourceId: groupId,
          });
        } catch (error) {
          logger.error('Error removing promptGroup permissions:', error);
        }
        await groups().deleteOne({ _id: groupId });
        await invalidatePromptGroupAccessContext();
        return {
          prompt: 'Prompt deleted successfully',
          promptGroup: { message: 'Prompt group deleted successfully', id: groupId },
        };
      }
      const promptGroup = await groups().findOne({ _id: groupId });
      if (promptGroup && promptGroup.productionId?.toString() === promptId.toString()) {
        await groups().updateOne(
          { _id: groupId },
          { productionId: remainingPrompts[remainingPrompts.length - 1]._id },
        );
      }
      return { prompt: 'Prompt deleted successfully' };
    },

    /**
     * Deletes the groups the user owns alone and their legacy (pre-ACL) groups, which only have
     * the author set; groups with other owners stay. ACL entries are the retry discovery key for
     * sole-owned groups, so they go last.
     */
    async deleteUserPrompts(userId) {
      try {
        const soleOwnedIds = await deps.getSoleOwnedResourceIds(userId, ResourceType.PROMPTGROUP);
        const authored = await groups().find({ author: userId }, { projection: '_id' });
        const authoredIds = authored.map((group) => group._id);
        const migrated =
          authoredIds.length > 0
            ? await acl().find(
                { resourceType: ResourceType.PROMPTGROUP, resourceId: { $in: authoredIds } },
                { projection: 'resourceId' },
              )
            : [];
        const migratedIds = new Set(migrated.map((entry) => String(entry.resourceId)));
        const legacyIds = authoredIds.filter((id) => !migratedIds.has(id));
        const allGroupIdsToDelete = [...soleOwnedIds, ...legacyIds];
        if (allGroupIdsToDelete.length === 0) {
          return;
        }
        await prompts().deleteMany({ groupId: { $in: allGroupIdsToDelete } });
        await groups().deleteMany({ _id: { $in: allGroupIdsToDelete } });
        await acl().deleteMany({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: { $in: allGroupIdsToDelete },
        });
        await invalidatePromptGroupAccessContext();
      } catch (error) {
        logger.error('[deleteUserPrompts] General error:', error);
        throw error;
      }
    },

    async makePromptProduction(promptId) {
      const prompt = await prompts().findOne({ _id: promptId });
      if (!prompt) {
        throw new Error('Prompt not found');
      }
      await groups().updateOne({ _id: prompt.groupId }, { productionId: prompt._id });
      return { message: 'Prompt production made successfully' };
    },

    async updatePromptLabels(_id, labels) {
      try {
        const response = await prompts().updateOne({ _id }, { $set: { labels } });
        if (response.matchedCount === 0) {
          return { message: 'Prompt not found' };
        }
        return { message: 'Prompt labels updated successfully' };
      } catch (error) {
        logger.error('Error updating prompt labels', error);
        return { message: 'Error updating prompt labels' };
      }
    },

    async findLangfusePromptGroup({ sourceDestination, sourceProjectId, sourcePromptName }) {
      const group = await groups().findOne(
        { source: 'langfuse', sourceDestination, sourceProjectId, sourcePromptName },
        { projection: '_id' },
      );
      return group ? { _id: String(group._id) } : null;
    },

    /**
     * A pointer-only group mirrored from a Langfuse prompt: name and source identity, no content
     * and no production prompt; the active tenant is stamped by the primitive. The partial unique
     * source-identity index rejects a second mirror with a duplicate key.
     */
    async createLangfusePromptGroup({
      name,
      author,
      authorName,
      sourceDestination,
      sourceProjectId,
      sourcePromptName,
    }) {
      const group = await groups().insertOne({
        source: 'langfuse',
        sourceDestination,
        sourceProjectId,
        sourcePromptName,
        name,
        author,
        authorName,
        category: '',
        oneliner: '',
        numberOfGenerations: 0,
      });
      return { _id: String(group._id) };
    },
  };
  return store;
}
