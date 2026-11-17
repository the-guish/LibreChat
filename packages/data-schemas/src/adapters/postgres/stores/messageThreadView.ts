/**
 * The bounded public projection of a subagent child thread (`getMessagesForSubagentThreadView`)
 * computed in JavaScript, value for value as the MongoDB method's aggregation computes it
 * (`~/methods/message`): text cut by code points, the visible activity vocabulary of a message's
 * content clipped per item and fitted newest first into the byte budget, the bounded task state
 * with its public control receipts, the trigger projection, and the activity sources (the
 * activity projection and the private transcript) with their availability rules. MongoDB emits
 * `null` where it means "omit this key"; so does this module, and the caller prunes them with the
 * shared `pruneProjectedThreadViewMessage`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * MongoDB's `$type` brackets map onto the values a lean read returns: a typed column holds one
 * type, `json` values are JSON types or dates; a number is any of `int`, `long`, `double`,
 * `decimal`. `$strLenBytes` is the UTF-8 length, `$strLenCP`/`$substrCP` count code points.
 */
import type { WithNullSentinels, ProjectedSubagentThreadViewMessage } from '~/methods/messageRules';
import type { SubagentThreadViewMessageRecord } from '~/types';
import {
  SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT,
  MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH,
  SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT,
  SUBAGENT_ACTIVITY_PROJECTION_SOURCE_BYTE_LIMIT,
  SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT,
} from '~/methods/messageRules';

/** A stored message as the thread view reads it (hidden subagent paths included). */
export type ThreadViewRow = Record<string, unknown>;

/** The activity source of one row: its projection or transcript payload, `null` when unusable. */
export type ThreadViewSource = WithNullSentinels<
  Pick<
    SubagentThreadViewMessageRecord,
    | 'messageId'
    | 'subagentTranscript'
    | 'subagentActivityProjectionJson'
    | 'subagentActivityProjectionTruncated'
  >,
  'subagentTranscript' | 'subagentActivityProjectionJson' | 'subagentActivityProjectionTruncated'
>;

type Item = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/** The value at a dotted path, `undefined` when a step is missing or not an object. */
function at(row: unknown, path: string): unknown {
  let value: unknown = row;
  for (const key of path.split('.')) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

/** Sets `key` unless the value is missing, as a `$project` drops an expression that is missing. */
function put(target: Item, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

const codePoints = (value: string): string[] => Array.from(value);
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const utf8Bytes = (value: unknown): number =>
  typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;

/** `$substrCP` of a string-gated value. */
const boundedString = (value: unknown, limit: number): string =>
  codePoints(asString(value)).slice(0, limit).join('');
/** `$strLenCP` of a string-gated value over the limit. */
const stringTruncated = (value: unknown, limit: number): boolean =>
  codePoints(asString(value)).length > limit;
const boundedStringArray = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [])
    .slice(0, SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT)
    .map((entry) => boundedString(entry, SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT));
const boundedNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const boundedBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;
const boundedEnum = (value: unknown, allowed: string[]): string | null =>
  typeof value === 'string' && allowed.includes(value) ? value : null;
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** One content part as an activity item, or `null` for a part outside the vocabulary. */
function activityItem(part: unknown): Item | null {
  const type = at(part, 'type');
  if (type === 'text') {
    return {
      type: 'writing',
      text: boundedString(at(part, 'text'), SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT),
      textTruncated: stringTruncated(
        at(part, 'text'),
        SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT,
      ),
    };
  }
  if (type === 'think' || type === 'reasoning') {
    return { type: 'reasoning' };
  }
  if (type === 'activity_label') {
    return {
      type: 'activity_label',
      label: boundedString(
        at(part, 'activity_label'),
        SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT,
      ),
      labelType: boundedEnum(at(part, 'activity_label_type'), ['phase']),
      toolCallIds: boundedStringArray(at(part, 'tool_call_ids')),
      activityStartIndex: boundedNumber(at(part, 'activity_start_index')),
      activityEndIndex: boundedNumber(at(part, 'activity_end_index')),
      activityCount: boundedNumber(at(part, 'activity_count')),
      agentIds: boundedStringArray(at(part, 'agent_ids')),
      status: boundedEnum(at(part, 'status'), ['ok', 'partial', 'failed']),
      pending: boundedBoolean(at(part, 'pending')),
      labelTruncated:
        stringTruncated(
          at(part, 'activity_label'),
          SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT,
        ) ||
        arrayOf(at(part, 'tool_call_ids')).length > SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT ||
        arrayOf(at(part, 'agent_ids')).length > SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
    };
  }
  if (type === 'tool_call') {
    return {
      type: 'tool',
      toolCallId: boundedString(
        at(part, 'tool_call.id'),
        SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
      ),
      name: boundedString(
        at(part, 'tool_call.name'),
        SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
      ),
      input: boundedString(
        at(part, 'tool_call.args'),
        SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT,
      ),
      output: boundedString(
        at(part, 'tool_call.output'),
        SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT,
      ),
      progress: boundedNumber(at(part, 'tool_call.progress')),
      runStepStatus: boundedEnum(at(part, 'tool_call.runStepStatus'), [
        'running',
        'completed',
        'failed',
        'cancelled',
      ]),
      inputValidationError: boundedBoolean(at(part, 'tool_call.inputValidationError')),
      inputTruncated: stringTruncated(
        at(part, 'tool_call.args'),
        SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT,
      ),
      outputTruncated: stringTruncated(
        at(part, 'tool_call.output'),
        SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT,
      ),
    };
  }
  return null;
}

/** The estimated serialized bytes of one clipped activity item (the BSON-transfer budget). */
function activityItemBytes(item: Item): number {
  if (item.type === 'writing') {
    return utf8Bytes(item.text) + 64;
  }
  if (item.type === 'activity_label') {
    const ids = [...arrayOf(item.toolCallIds), ...arrayOf(item.agentIds)];
    return (
      utf8Bytes(item.label) + ids.reduce<number>((sum, id) => sum + utf8Bytes(id) + 8, 0) + 512
    );
  }
  if (item.type === 'tool') {
    return (
      utf8Bytes(item.input) +
      utf8Bytes(item.output) +
      utf8Bytes(item.name) +
      utf8Bytes(item.toolCallId) +
      192
    );
  }
  return 32;
}

/** The newest contiguous suffix of the clipped items that fits the aggregate byte budget. */
function budgetedActivity(clipped: Item[]): Item[] {
  const fitted: Item[] = [];
  let bytes = 0;
  for (let index = clipped.length - 1; index >= 0; index -= 1) {
    const size = activityItemBytes(clipped[index]);
    if (bytes + size > SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT) {
      break;
    }
    fitted.push(clipped[index]);
    bytes += size;
  }
  return fitted.reverse();
}

/** One public control receipt, its strings bounded. */
function boundedControlReceipt(receipt: unknown): Item {
  const projected: Item = {
    invocationId: boundedString(
      at(receipt, 'invocationId'),
      SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT,
    ),
    controlId:
      typeof at(receipt, 'controlId') === 'string'
        ? boundedString(at(receipt, 'controlId'), SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT)
        : null,
  };
  put(projected, 'action', at(receipt, 'action'));
  put(projected, 'status', at(receipt, 'status'));
  put(projected, 'createdAt', at(receipt, 'createdAt'));
  put(projected, 'updatedAt', at(receipt, 'updatedAt'));
  put(projected, 'boundary', at(receipt, 'boundary'));
  projected.reason =
    typeof at(receipt, 'reason') === 'string'
      ? boundedString(at(receipt, 'reason'), SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT)
      : null;
  projected.message =
    typeof at(receipt, 'message') === 'string'
      ? boundedString(at(receipt, 'message'), MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH)
      : null;
  projected.messageTruncated =
    at(receipt, 'messageTruncated') === true ||
    stringTruncated(at(receipt, 'message'), MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH);
  return projected;
}

/** The bounded task state: status, the newest public receipts (accepted first), the overflow flag. */
function boundedSubagentTask(task: unknown): Item | null {
  if (!isRecord(task)) {
    return null;
  }
  const visible = arrayOf(task.controlReceipts).filter(
    (receipt) => at(receipt, 'status') !== 'reserved',
  );
  const accepted = visible
    .filter((receipt) => at(receipt, 'status') === 'accepted')
    .slice(0, SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT);
  const terminal = visible.filter((receipt) => at(receipt, 'status') !== 'accepted');
  const allowance = SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT - accepted.length;
  const projected: Item = {};
  put(projected, 'status', task.status);
  projected.controlReceipts = [
    ...accepted,
    ...(allowance > 0 ? terminal.slice(-allowance) : []),
  ].map(boundedControlReceipt);
  projected.controlReceiptsProjectionTruncated =
    visible.length > SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT;
  return projected;
}

/** The trigger projection of a version 1 trigger, its strings bounded; `null` otherwise. */
function boundedTriggerProjection(trigger: unknown): Item | null {
  if (at(trigger, 'version') !== 1) {
    return null;
  }
  const projected: Item = {
    version: 1,
    eventType: boundedString(
      at(trigger, 'eventType'),
      SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
    ),
    sourceType: boundedString(
      at(trigger, 'sourceType'),
      SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
    ),
  };
  put(projected, 'occurredAt', at(trigger, 'occurredAt'));
  projected.expectedActionToolName =
    typeof at(trigger, 'expectedActionToolName') === 'string'
      ? boundedString(
          at(trigger, 'expectedActionToolName'),
          SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
        )
      : null;
  return projected;
}

/** The bounded public fields of one message (MongoDB's `boundedMessageProjection`). */
export function projectThreadViewMessage(
  row: ThreadViewRow,
  textCodePointLimit: number,
): ProjectedSubagentThreadViewMessage {
  const content = arrayOf(row.content);
  const clipped = content
    .slice(-SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT)
    .map(activityItem)
    .filter((item): item is Item => item != null);
  const text = typeof row.text === 'string' ? row.text : '';
  const projected: Item = {};
  put(projected, 'messageId', row.messageId);
  put(projected, 'parentMessageId', row.parentMessageId);
  put(projected, 'isCreatedByUser', row.isCreatedByUser);
  projected.text = codePoints(text).slice(0, textCodePointLimit).join('');
  projected.textProjectionTruncated = codePoints(text).length > textCodePointLimit;
  put(projected, 'createdAt', row.createdAt);
  put(projected, 'error', row.error);
  put(projected, 'unfinished', row.unfinished);
  projected.contentRecoveryAvailable =
    (at(row, 'subagentContent.version') ?? 0) === 1 &&
    (at(row, 'subagentContent.deleted') ?? false) !== true;
  projected.subagentTranscriptProjectionTruncated =
    at(row, 'subagentTranscript.messagesJson') !== undefined ? true : null;
  projected.subagentActivity = budgetedActivity(clipped);
  projected.subagentActivityProjectionTruncated =
    content.length > SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT ||
    clipped.reduce((sum, item) => sum + activityItemBytes(item), 0) >
      SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT;
  projected.subagentTask = boundedSubagentTask(row.subagentTask);
  projected.subagentTriggerProjection = boundedTriggerProjection(row.subagentTriggerProjection);
  return projected as ProjectedSubagentThreadViewMessage;
}

/** Whether the row's activity projection is a usable source (MongoDB's `activityProjectionAvailable`). */
export function activityProjectionAvailable(row: ThreadViewRow): boolean {
  const version = at(row, 'subagentActivityProjection.version');
  const taskId = at(row, 'subagentActivityProjection.taskId');
  const json = at(row, 'subagentActivityProjection.activityJson');
  return (
    (version === 1 || version === 2) &&
    typeof taskId === 'string' &&
    row.messageId === `${taskId}:assistant` &&
    typeof json === 'string' &&
    utf8Bytes(json) <= SUBAGENT_ACTIVITY_PROJECTION_SOURCE_BYTE_LIMIT
  );
}

/** Whether the row's private transcript is a usable source (MongoDB's `transcriptAvailable`). */
export function transcriptAvailable(row: ThreadViewRow): boolean {
  const json = at(row, 'subagentTranscript.messagesJson');
  const taskId = at(row, 'subagentTranscript.taskId');
  return (
    typeof json === 'string' &&
    typeof taskId === 'string' &&
    row.messageId === `${taskId}:assistant` &&
    utf8Bytes(json) <= SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT
  );
}

/** The row's activity source payload (MongoDB's `activitySourcePayload`), with its message id. */
export function threadViewSource(row: ThreadViewRow): ThreadViewSource {
  const activity = activityProjectionAvailable(row);
  const transcript = transcriptAvailable(row);
  /** Legacy reprojection is optional: retain the usable projection until the API validates the
   * current input boundary against the bounded transcript. */
  const legacySteering =
    at(row, 'subagentActivityProjection.version') === 1 &&
    transcript &&
    asString(at(row, 'subagentTranscript.messagesJson')).includes('"source":"steer"');
  const source: Item = {};
  put(source, 'messageId', row.messageId);
  source.subagentActivityProjectionJson = activity
    ? at(row, 'subagentActivityProjection.activityJson')
    : null;
  const truncated = activity ? at(row, 'subagentActivityProjection.truncated') : null;
  put(source, 'subagentActivityProjectionTruncated', truncated);
  if (transcript && (!activity || legacySteering)) {
    const payload: Item = {};
    put(payload, 'taskId', at(row, 'subagentTranscript.taskId'));
    put(payload, 'mode', at(row, 'subagentTranscript.mode'));
    put(payload, 'messagesJson', at(row, 'subagentTranscript.messagesJson'));
    source.subagentTranscript = payload;
  } else {
    source.subagentTranscript = null;
  }
  return source as ThreadViewSource;
}

/** Whether the row carries an activity source at all (either source path exists, even `null`). */
export function hasThreadViewSourcePaths(row: ThreadViewRow): boolean {
  return (
    at(row, 'subagentActivityProjection.activityJson') !== undefined ||
    at(row, 'subagentTranscript.messagesJson') !== undefined
  );
}
