/**
 * A store's duplicate-key error, as the error middleware answers it with a 409: recognized with
 * `isDuplicateKeyError` from `@librechat/data-schemas`, whatever the database. `code` is the
 * backend's own error code when it has one (logged); the violated key's fields come from
 * `duplicateKeyFields` (the keys of `keyValue`).
 */
export interface DuplicateKeyError extends Error {
  code?: number | string;
  keyValue?: Record<string, unknown>;
}

/** @deprecated The MongoDB-era name of {@link DuplicateKeyError}, kept for existing imports. */
export type MongoServerError = DuplicateKeyError;

/** A validation error (mongoose's `ValidationError` has this shape) */
export interface ValidationError extends Error {
  name: 'ValidationError';
  errors: Record<
    string,
    {
      message: string;
      path?: string;
    }
  >;
}

/** Custom error with status code and body */
export interface CustomError extends Error {
  statusCode?: number;
  body?: unknown;
  code?: string | number;
}
