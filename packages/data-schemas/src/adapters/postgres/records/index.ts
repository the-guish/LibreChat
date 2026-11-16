/**
 * The record codec of the PostgreSQL backend (docs/postgres-port/PHASE4.md §1, §3.1, §3.2):
 * documents to rows and back, the descriptor caster, and the `_nulls`/`_extra` rules. Must not
 * import `mongoose`, `mongodb` or `bson` (the schema engine, which does, is `schema/engine.ts`).
 */
export { indexRecordTables, lastSegment } from './tables';
export type { RecordTable, RecordTables } from './tables';
export { parsePosition, castTargetOf, resolveRecordPath, UndeclaredPathError } from './paths';
export type {
  PathHop,
  CastTarget,
  PathPosition,
  ResolvedNode,
  ResolvedPath,
  ResolveOptions,
} from './paths';
export { castScalar, canonicalizeValue, createRecordCaster } from './cast';
export type {
  RecordCaster,
  ScalarCastOptions,
  UpdateCastOptions,
  UpdateCastEngine,
  SubdocumentOperator,
  RecordCasterOptions,
  UndeclaredUpdatePaths,
} from './cast';
export { decomposeRecord, insertStatements, insertRowsStatements } from './decompose';
export type {
  ChildRows,
  SqlStatement,
  DivertedValue,
  DecomposeMode,
  DecomposeOptions,
  DecomposedRecord,
} from './decompose';
export { readRecords, selectRecord, readChildRows } from './assemble';
export type {
  Queryable,
  ChildSelect,
  RecordSelect,
  ChildRowBatch,
  PathSelection,
  ChildReadMode,
  RecordProjection,
  ReadRecordsOptions,
  SelectRecordOptions,
} from './assemble';
export { toNullsColumn, fromNullsColumn, updateNulls, presenceSql, absenceSql } from './nulls';
export {
  mergeExtra,
  isPlainRecord,
  setExtraValue,
  getExtraValue,
  unsetExtraValue,
  encodeExtraColumn,
  decodeExtraColumn,
} from './extra';
export type { ExtraValues } from './extra';
