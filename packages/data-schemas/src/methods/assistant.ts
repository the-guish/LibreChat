import type { FilterQuery, Model, ProjectionType } from 'mongoose';
import type { AssistantQuery, IAssistant } from '~/types';
import {
  assistantCriteria,
  assistantAvatarSeedId,
  isAvatarUpdateNeeded,
  assistantAvatarGuard,
  assistantAvatarUpdate,
  validateAssistantAvatarUpdate,
} from './assistantRules';
import { createIndexesWithRetry } from '~/utils/retry';

/** Translates domain assistant criteria into a Mongo filter (`assistantCriteria`). */
function assistantFilter(query: AssistantQuery): FilterQuery<IAssistant> {
  return assistantCriteria(query) as FilterQuery<IAssistant>;
}

export function createAssistantMethods(mongoose: typeof import('mongoose')): {
  updateAssistantDoc: (
    query: AssistantQuery,
    updateData: Partial<IAssistant>,
  ) => Promise<IAssistant | null>;
  updateAssistantAvatar: (
    query: { assistantId: string; user?: string },
    avatar: NonNullable<IAssistant['avatar']>,
    onInsert?: { user: string; endpoint: string },
  ) => Promise<(IAssistant & { previousAvatar?: IAssistant['avatar'] }) | null>;
  deleteAssistant: (query: AssistantQuery) => Promise<IAssistant | null>;
  deleteAssistants: (query: AssistantQuery) => Promise<number>;
  getAssistants: (
    query: AssistantQuery,
    select?: string | Record<string, number> | null,
  ) => Promise<IAssistant[]>;
  getAssistant: (
    query: AssistantQuery,
    projection?: ProjectionType<IAssistant>,
  ) => Promise<IAssistant | null>;
  ensureAssistantIndexes: () => Promise<void>;
} {
  const Assistant = () => mongoose.models.Assistant as Model<IAssistant>;
  let assistantIndexesPromise: Promise<void> | null = null;

  function ensureAssistantIndexes(): Promise<void> {
    if (!assistantIndexesPromise) {
      assistantIndexesPromise = createIndexesWithRetry(Assistant()).catch((error) => {
        assistantIndexesPromise = null;
        throw error;
      });
    }
    return assistantIndexesPromise;
  }

  /**
   * Update an assistant with new data without overwriting existing properties,
   * or create a new assistant if it doesn't exist.
   */
  async function updateAssistantDoc(
    query: AssistantQuery,
    updateData: Partial<IAssistant>,
  ): Promise<IAssistant | null> {
    const options = { new: true, upsert: true };
    return await Assistant()
      .findOneAndUpdate(assistantFilter(query), updateData, options)
      .lean<IAssistant>();
  }

  /** Updates avatar and absent identity atomically; unmatched references return null without insert data. */
  async function updateAssistantAvatar(
    query: { assistantId: string; user?: string },
    avatar: NonNullable<IAssistant['avatar']>,
    onInsert?: { user: string; endpoint: string },
  ): Promise<(IAssistant & { previousAvatar?: IAssistant['avatar'] }) | null> {
    const insertData = validateAssistantAvatarUpdate(query, onInsert);
    const { assistantId, user } = query;
    let reference = await Assistant().findOne(assistantFilter({ assistantId })).lean<IAssistant>();
    if (!reference) {
      if (!insertData) {
        return null;
      }
      // The built-in unique _id index arbitrates concurrent initialization across replicas.
      const _id = new mongoose.Types.ObjectId(assistantAvatarSeedId(assistantId));
      try {
        const created = await Assistant().create({
          _id,
          assistant_id: assistantId,
          ...insertData,
          avatar,
        });
        return created.toObject<IAssistant>();
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error == null ||
          !('code' in error) ||
          error.code !== 11000
        ) {
          throw error;
        }
        reference = await Assistant()
          .findOne({ _id, assistant_id: assistantId })
          .lean<IAssistant>();
        if (!reference) {
          throw error;
        }
      }
    }
    if (user !== undefined && reference.user?.toString() !== user) {
      if (!insertData) {
        return null;
      }
      if (reference.user != null) {
        throw new Error('Assistant ownership changed before the avatar update');
      }
    }

    if (!isAvatarUpdateNeeded(reference, avatar, insertData)) {
      return reference;
    }

    // Avatar and backfill share one identity guard, so a lost race cannot partially mutate the row.
    const updated = await Assistant()
      .findOneAndUpdate(
        { _id: reference._id, ...assistantAvatarGuard(reference, assistantId) },
        assistantAvatarUpdate(reference, avatar, insertData),
        { new: true },
      )
      .lean<IAssistant>();
    if (!updated) {
      throw new Error('Assistant identity changed before the avatar update');
    }
    return Object.assign(updated, { previousAvatar: reference.avatar });
  }

  /**
   * Retrieves an assistant document based on the provided search params.
   */
  async function getAssistant(
    query: AssistantQuery,
    projection?: ProjectionType<IAssistant>,
  ): Promise<IAssistant | null> {
    await ensureAssistantIndexes();
    return await Assistant().findOne(assistantFilter(query), projection).lean<IAssistant>();
  }

  /**
   * Retrieves all assistants that match the given search parameters.
   */
  async function getAssistants(
    query: AssistantQuery,
    select: string | Record<string, number> | null = null,
  ): Promise<IAssistant[]> {
    const search = Assistant().find(assistantFilter(query));

    return await (select ? search.select(select) : search).lean<IAssistant[]>();
  }

  /**
   * Deletes an assistant based on the provided search params.
   */
  async function deleteAssistant(query: AssistantQuery): Promise<IAssistant | null> {
    return await Assistant().findOneAndDelete(assistantFilter(query));
  }

  /**
   * Deletes all assistants matching the given search parameters.
   */
  async function deleteAssistants(query: AssistantQuery): Promise<number> {
    const result = await Assistant().deleteMany(assistantFilter(query));
    return result.deletedCount;
  }

  return {
    updateAssistantDoc,
    updateAssistantAvatar,
    deleteAssistant,
    deleteAssistants,
    getAssistants,
    getAssistant,
    ensureAssistantIndexes,
  };
}

export type AssistantMethods = ReturnType<typeof createAssistantMethods>;
