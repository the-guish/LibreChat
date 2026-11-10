/**
 * Assistant store port: the local records LibreChat keeps for provider-hosted assistants (owner,
 * endpoint, avatar, conversation starters and other settings). Nothing here may import
 * `mongoose`. Signatures are copied verbatim from `AssistantMethods` (`~/methods/assistant`);
 * `assistant.spec.ts` fails the typecheck if the two drift. Criteria are `AssistantQuery` domain
 * fields, combined with AND; an array matches any of its entries.
 *
 * `getAssistant` and `getAssistants` are not in this port: each takes a raw MongoDB projection.
 *
 * Known leak kept for now so callers stay unchanged: `IAssistant` extends mongoose's `Document`
 * (its `user` is an ObjectId), and `updateAssistantDoc` takes a `Partial<IAssistant>` field
 * patch.
 */
import type { AssistantQuery, IAssistant } from '~/types';
import { listPortMethods } from './common';

export interface AssistantStore {
  /**
   * Sets the given fields on the first assistant matching the criteria, creating it when there
   * is none; resolves to it updated.
   */
  updateAssistantDoc(
    query: AssistantQuery,
    updateData: Partial<IAssistant>,
  ): Promise<IAssistant | null>;
  /**
   * Sets the assistant's avatar and, with `onInsert`, fills a missing owner and endpoint, in one
   * write guarded by the identity it read; creates the record from `onInsert` when there is
   * none. Resolves to the record with the replaced avatar as `previousAvatar`, or `null` when the
   * assistant is missing or owned by another user and there is no insert data. Throws a
   * `TypeError` on malformed input, and an error when the identity changed mid-update.
   */
  updateAssistantAvatar(
    query: { assistantId: string; user?: string },
    avatar: NonNullable<IAssistant['avatar']>,
    onInsert?: { user: string; endpoint: string },
  ): Promise<(IAssistant & { previousAvatar?: IAssistant['avatar'] }) | null>;
  /** Deletes the first assistant matching the criteria and resolves to it, or `null`. */
  deleteAssistant(query: AssistantQuery): Promise<IAssistant | null>;
  /** Deletes every assistant matching the criteria; resolves how many. */
  deleteAssistants(query: AssistantQuery): Promise<number>;
  /** Makes sure the assistant indexes exist; a failed build is retried on the next call. */
  ensureAssistantIndexes(): Promise<void>;
}

/** Every method of {@link AssistantStore}, for adapters and conformance checks. */
export const ASSISTANT_STORE_METHODS: ReadonlyArray<keyof AssistantStore> =
  listPortMethods<AssistantStore>({
    updateAssistantDoc: true,
    updateAssistantAvatar: true,
    deleteAssistant: true,
    deleteAssistants: true,
    ensureAssistantIndexes: true,
  });
