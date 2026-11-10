/**
 * Memory store port: the key-value memories kept for a user, either in the shared personal pool
 * or in one agent's partition (`agentId`). Nothing here may import `mongoose`. Signatures are
 * those of `MemoryMethods` (`~/methods/memory`) with user ids stated as `IdLike`;
 * `memory.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * A key is unique within a user's partition; the key `nothing` is never stored (the write
 * resolves `{ ok: false }`). Failures other than those the results describe are thrown as errors
 * whose message names the operation.
 *
 * Known leak kept for now so callers stay unchanged: `IMemoryEntryLean` carries the record's
 * ObjectIds (`_id`, `userId`).
 */
import type {
  MemoryResult,
  SetMemoryParams,
  MemoryByIdParams,
  IMemoryEntryLean,
  DeleteMemoryParams,
  SetMemoryByIdParams,
  SetMemoryByIdResult,
  GetUserMemoriesParams,
  FormattedMemoriesResult,
  GetFormattedMemoriesParams,
} from '~/types';
import type { IdLike, WithIdLike } from './common';
import { listPortMethods } from './common';

export interface MemoryStore {
  /** Creates or replaces the memory `key` in the user's partition. */
  setMemory(params: WithIdLike<SetMemoryParams, 'userId'>): Promise<MemoryResult>;
  /** Creates the memory `key` in the user's partition; throws when the key already exists. */
  createMemory(params: WithIdLike<SetMemoryParams, 'userId'>): Promise<MemoryResult>;
  /** Deletes the memory `key` from the user's partition; `ok` is whether there was one. */
  deleteMemory(params: WithIdLike<DeleteMemoryParams, 'userId'>): Promise<MemoryResult>;
  /**
   * Updates the user's memory `id` in the partition, renaming it to `key` when given;
   * `conflict` when another memory there already has that key, `ok: false` when there is no
   * such memory or `id` is not a valid id.
   */
  setMemoryById(params: WithIdLike<SetMemoryByIdParams, 'userId'>): Promise<SetMemoryByIdResult>;
  /** Deletes the user's memory `id` from the partition; `ok` is whether there was one. */
  deleteMemoryById(params: WithIdLike<MemoryByIdParams, 'userId'>): Promise<MemoryResult>;
  /** Every memory of the user, in every partition. */
  getAllUserMemories(userId: IdLike): Promise<IMemoryEntryLean[]>;
  /** The memories of the user's partition. */
  getUserMemories(params: WithIdLike<GetUserMemoriesParams, 'userId'>): Promise<IMemoryEntryLean[]>;
  /**
   * The memories of the user's partition, oldest update first, as numbered prompt text with and
   * without keys, with their token counts. A failed read resolves `readFailed: true` instead of
   * throwing.
   */
  getFormattedMemories(
    params: WithIdLike<GetFormattedMemoriesParams, 'userId'>,
  ): Promise<FormattedMemoriesResult>;
  /** Deletes every memory of the user; resolves how many. */
  deleteAllUserMemories(userId: IdLike): Promise<number>;
}

/** Every method of {@link MemoryStore}, for adapters and conformance checks. */
export const MEMORY_STORE_METHODS: ReadonlyArray<keyof MemoryStore> = listPortMethods<MemoryStore>({
  setMemory: true,
  createMemory: true,
  deleteMemory: true,
  setMemoryById: true,
  deleteMemoryById: true,
  getAllUserMemories: true,
  getUserMemories: true,
  getFormattedMemories: true,
  deleteAllUserMemories: true,
});
