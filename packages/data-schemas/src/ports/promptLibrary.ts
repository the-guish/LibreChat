/**
 * Prompt library store port: prompt groups (a named, categorized prompt with its revisions) and
 * their prompts, one of which is a group's production prompt, plus the per-user sets of group
 * ids a user can see. Nothing here may import `mongoose`. Signatures are those of
 * `PromptMethods` (`~/methods/prompt`) with ids stated as `IdLike`, and the criteria and
 * updates of `getPromptGroups`, `getAllPromptGroups`, `getPrompts`, `getPrompt`,
 * `getPromptGroup` and `updatePromptGroup` stated in the store query language (`./query`);
 * `promptLibrary.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * Named apart from `PromptStore` (`@librechat/api`'s `prompts/types`), the service-level store
 * the prompt handlers are built on, which these methods back.
 *
 * Authorization is enforced by callers: the deletes and updates here act on any group or prompt
 * by id. Writes that can change which groups a user sees (creating or deleting a group) drop the
 * cached access sets of the caller's tenant. Group listings carry each group's production
 * prompt (its text) as `productionPrompt` and its author as a string.
 *
 * Known leaks kept for now so callers stay unchanged: `createPromptGroup` and `savePrompt`
 * take the group's and prompt's fields as an untyped record (`createPromptGroup` reuses a
 * native group whose fields equal the given ones), and `IPromptRecord` and `IPromptGroup` carry
 * the record's ObjectIds. `getPromptGroup` matches its filter in a MongoDB aggregation, which
 * does not cast values through the schema: the method casts a string `_id` itself, but any other
 * id field must be given as the id value the store handed out, not its string form (callers pass
 * only `{ _id }`). `getPrompt` reads a `groupId` condition as one id (it casts it in the
 * caller's filter object), not an operator record.
 */
import type { IPromptGroup, IPromptRecord, PromptGroupListParams } from '~/types';
import type { StoreFilter, StoreUpdate } from './query';
import type { IdLike } from './common';
import { listPortMethods } from './common';

/** {@link PromptGroupListParams} with the accessible group ids stated as `IdLike`. */
export type PromptLibraryListParams = Omit<PromptGroupListParams, 'accessibleIds'> & {
  accessibleIds?: IdLike[];
};

/**
 * The criteria of the unscoped prompt group listings: a filter on prompt groups, except for
 * `name`, a case-insensitive substring of the group's name, and `category`, where the system
 * categories `MY_PROMPTS` and `SHARED_PROMPTS` (or none) select every category and
 * `NO_CATEGORY` selects the groups without one.
 */
export type PromptLibraryGroupFilter = StoreFilter & { name?: string; category?: string };

/**
 * {@link PromptLibraryGroupFilter} with the page `getPromptGroups` returns: `pageNumber` (from 1)
 * of pages of `pageSize` groups (1 and 10 when omitted).
 */
export type PromptLibraryGroupPageFilter = PromptLibraryGroupFilter & {
  pageNumber?: number | string;
  pageSize?: number | string;
};

export interface PromptLibraryStore {
  /**
   * One page of the groups matching `filter`, most used first, each with its production prompt;
   * resolves `{ message }` instead of throwing when the read fails. No caller uses it.
   */
  getPromptGroups(filter: PromptLibraryGroupPageFilter): Promise<
    | {
        promptGroups: Record<string, unknown>[];
        pageNumber: string;
        pageSize: string;
        pages: string;
      }
    | { message: string }
  >;
  /**
   * Every group matching `filter`, most used first, each with its production prompt; resolves
   * `{ message }` instead of throwing when the read fails. No caller uses it.
   */
  getAllPromptGroups(
    filter: PromptLibraryGroupFilter,
  ): Promise<Record<string, unknown>[] | { message: string }>;
  /**
   * The first group matching `filter` (callers pass `{ _id }`), with its production prompt as
   * `productionPrompt` (`null` when it belongs to another tenant) and its author as a string, or
   * `null`. See the leaks above for how the filter is matched.
   */
  getPromptGroup(filter: StoreFilter): Promise<Record<string, unknown> | null>;
  /**
   * Updates the first group matching `filter` (callers pass `{ _id }` and a record of the
   * fields to set) and resolves to it updated; throws `Prompt group not found` when none
   * matches.
   */
  updatePromptGroup(filter: StoreFilter, data: StoreUpdate): Promise<IPromptGroup>;
  /** Every prompt matching `filter` (callers pass `{ groupId }`), newest first. */
  getPrompts(filter: StoreFilter): Promise<IPromptRecord[]>;
  /**
   * The first prompt matching `filter` (callers pass `{ _id }`), or `null`. See the leaks above
   * for a `groupId` condition.
   */
  getPrompt(filter: StoreFilter): Promise<IPromptRecord | null>;
  /**
   * Deletes the group and its prompts and removes every permission on it; throws `Prompt group
   * not found` when there is none.
   */
  deletePromptGroup(params: { _id: string }): Promise<{ message: string }>;
  /**
   * The groups among `accessibleIds` (optionally only those whose name contains `name`, or of
   * `category`), most used first. With `limit` (1 to 100, 20 when unparsable) a page of them;
   * `after` is the cursor the previous page returned. Without `limit`, all of them.
   */
  getListPromptGroupsByAccess(params: PromptLibraryListParams): Promise<{
    object: 'list';
    data: Record<string, unknown>[];
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
    after: string | null;
  }>;
  /** Adds one to the group's use count and resolves to it; throws for an unknown group. */
  incrementPromptGroupUsage(groupId: string): Promise<{ numberOfGenerations: number }>;
  /**
   * Creates a native group (or reuses one with the same fields and no production prompt) with
   * the prompt as its first revision and production prompt.
   */
  createPromptGroup(saveData: {
    prompt: Record<string, unknown>;
    group: Record<string, unknown>;
    author: string;
    authorName: string;
  }): Promise<{ prompt: Record<string, unknown> | null; group: Record<string, unknown> }>;
  /** Stores a new prompt (a revision of the group it names) by the author. */
  savePrompt(saveData: {
    prompt: Record<string, unknown>;
    author: IdLike;
  }): Promise<{ prompt: IPromptRecord }>;
  /**
   * The ids of the groups the user authored, empty for an id that is not one the store
   * generated. With `readPrimary`, the read must see every committed write.
   */
  getOwnedPromptGroupIds(author: string, readPrimary?: boolean): Promise<IdLike[]>;
  /**
   * The ids of the groups the user (with the role) may view through any principal, of the
   * groups anyone may view, and of the groups the user authored; cached per tenant until a
   * change drops them.
   */
  getPromptGroupAccessContext(params: { userId: string; role?: string }): Promise<{
    accessibleIds: IdLike[];
    publiclyAccessibleIds: IdLike[];
    ownedPromptGroupIds: IdLike[];
  }>;
  /**
   * Drops the cached access sets of the caller's tenant; throws when they could be neither
   * dropped nor bypassed.
   */
  invalidatePromptGroupAccessContext(): Promise<void>;
  /**
   * Deletes the prompt from the group. The last prompt of a group takes the group (and its
   * permissions) with it, reported as `promptGroup`; deleting the production prompt makes the
   * newest remaining prompt the production one. Throws when there is no such prompt.
   */
  deletePrompt(params: {
    promptId: IdLike;
    groupId: IdLike;
  }): Promise<{ prompt: string; promptGroup?: { message: string; id: IdLike } }>;
  /**
   * Deletes the groups (and their prompts and permissions) the user owns alone, and the legacy
   * groups they authored that have no permissions; shared groups stay.
   */
  deleteUserPrompts(userId: string): Promise<void>;
  /** Makes the prompt its group's production prompt; throws `Prompt not found`. */
  makePromptProduction(promptId: string): Promise<{ message: string }>;
  /** Sets the prompt's labels; resolves a message rather than throwing. */
  updatePromptLabels(_id: string, labels: unknown): Promise<{ message: string }>;
  /** The group mirrored from the Langfuse prompt with this identity, or `null`. */
  findLangfusePromptGroup(identity: {
    sourceDestination: string;
    sourceProjectId: string;
    sourcePromptName: string;
  }): Promise<{ _id: string } | null>;
  /**
   * Creates a group mirrored from a Langfuse prompt: its name and source identity, no prompt
   * content. Throws a duplicate-key error when one with that identity exists.
   */
  createLangfusePromptGroup(input: {
    name: string;
    author: string;
    authorName: string;
    sourceDestination: string;
    sourceProjectId: string;
    sourcePromptName: string;
  }): Promise<{ _id: string }>;
}

/** Every method of {@link PromptLibraryStore}, for adapters and conformance checks. */
export const PROMPT_LIBRARY_STORE_METHODS: ReadonlyArray<keyof PromptLibraryStore> =
  listPortMethods<PromptLibraryStore>({
    getPromptGroups: true,
    getAllPromptGroups: true,
    getPromptGroup: true,
    updatePromptGroup: true,
    getPrompts: true,
    getPrompt: true,
    deletePromptGroup: true,
    getListPromptGroupsByAccess: true,
    incrementPromptGroupUsage: true,
    createPromptGroup: true,
    savePrompt: true,
    getOwnedPromptGroupIds: true,
    getPromptGroupAccessContext: true,
    invalidatePromptGroupAccessContext: true,
    deletePrompt: true,
    deleteUserPrompts: true,
    makePromptProduction: true,
    updatePromptLabels: true,
    findLangfusePromptGroup: true,
    createLangfusePromptGroup: true,
  });
