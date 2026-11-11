import { getDataStoreBackend } from '@librechat/data-schemas';

/**
 * The size limit of one stored record with MongoDB (`documents.maxDocumentBytes` of the MongoDB
 * backend). The check reads the limit from the backend, so these name the MongoDB values.
 */
export const MAX_CONVERSATION_IMPORT_BSON_BYTES: number = 16 * 1024 * 1024;
/** Room kept below the store's limit for what later writes add to an imported record. */
export const CONVERSATION_IMPORT_BSON_HEADROOM_BYTES: number = 64 * 1024;
/** The largest imported conversation or message accepted with MongoDB. */
export const MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES: number =
  MAX_CONVERSATION_IMPORT_BSON_BYTES - CONVERSATION_IMPORT_BSON_HEADROOM_BYTES;

/** A conversation or message about to be written, as the import builds it. */
export type ConversationImportDocument = Record<string, unknown>;

export interface ConversationImportWriteBatch {
  conversations: readonly ConversationImportDocument[];
  messages: readonly ConversationImportDocument[];
  tenantId?: string;
}

export interface ConversationImportWriteOperations {
  saveConversations: () => Promise<void>;
  saveMessages: () => Promise<void>;
  updateTagCounts: () => Promise<void>;
  deleteMessages: () => Promise<void>;
  deleteConversations: () => Promise<void>;
  onTagCountError?: (error: Error) => void;
  onCleanupError?: (error: Error, resource: 'messages' | 'conversations') => void;
}

export class ConversationImportError extends Error {
  readonly code = 'invalid_request';
  readonly statusCode: number;
  readonly body: { error: 'invalid_request'; message: string };

  constructor(message: string, statusCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConversationImportError';
    this.statusCode = statusCode;
    this.body = { error: 'invalid_request', message };
  }
}

function importWriteError(
  message: string,
  statusCode: number,
  cause?: unknown,
): ConversationImportError {
  return new ConversationImportError(
    message,
    statusCode,
    cause === undefined ? undefined : { cause },
  );
}

export function isConversationImportError(error: unknown): error is ConversationImportError {
  return error instanceof ConversationImportError;
}

/**
 * Refuses a batch with a record the store could not take, before any write begins: each
 * conversation and message is measured as the store will hold it (`StoreDocuments` of the
 * backend: with MongoDB its BSON size with `_id`, `__v` and the tenant) against the store's
 * limit less {@link CONVERSATION_IMPORT_BSON_HEADROOM_BYTES}.
 */
export function assertConversationImportWriteSize(batch: ConversationImportWriteBatch): void {
  const documents = getDataStoreBackend().documents;
  const maxDocumentBytes = documents.maxDocumentBytes - CONVERSATION_IMPORT_BSON_HEADROOM_BYTES;
  const assertDocumentSize = (document: ConversationImportDocument): void => {
    let size: number;
    try {
      size = documents.measureDocument({
        ...document,
        ...(batch.tenantId == null ? {} : { tenantId: batch.tenantId }),
      });
    } catch (error) {
      throw importWriteError('An imported conversation or message cannot be stored', 400, error);
    }
    if (size > maxDocumentBytes) {
      throw importWriteError(
        `Each imported conversation or message must be at most ${maxDocumentBytes} bytes`,
        413,
      );
    }
  };
  for (const conversation of batch.conversations) {
    assertDocumentSize(conversation);
  }
  for (const message of batch.messages) {
    assertDocumentSize(message);
  }
}

export async function executeConversationImportWrites(
  operations: ConversationImportWriteOperations,
): Promise<void> {
  try {
    await operations.saveConversations();
    await operations.saveMessages();
  } catch (error) {
    try {
      await operations.deleteMessages();
    } catch (cleanupError) {
      operations.onCleanupError?.(
        cleanupError instanceof Error
          ? cleanupError
          : new Error('Failed to clean imported messages'),
        'messages',
      );
      throw error;
    }

    try {
      await operations.deleteConversations();
    } catch (cleanupError) {
      operations.onCleanupError?.(
        cleanupError instanceof Error
          ? cleanupError
          : new Error('Failed to clean imported conversations'),
        'conversations',
      );
    }
    throw error;
  }

  try {
    await operations.updateTagCounts();
  } catch (error) {
    operations.onTagCountError?.(
      error instanceof Error ? error : new Error('Failed to update imported tag counts'),
    );
  }
}
