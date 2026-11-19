/**
 * Subagent content store port: the journal of a subagent run's events (its streamed content),
 * written in numbered batches while the run holds its thread's lease and read back to replay
 * the run. Nothing here may import `mongoose`. Signatures are copied verbatim from
 * `SubagentContentMethods` (`~/methods/subagentContent`); `subagentContent.spec.ts` fails the
 * typecheck if the two drift.
 *
 * A run is identified by its {@link SubagentContentScope}. Each batch commits at a revision
 * (from 1) the events from `fromSequence` to `throughSequence`; a batch is visible only once
 * all of it is stored, and retrying a commit with the same bytes changes nothing. A run's
 * content lives only as long as its seed message (`<taskId>:user`), its parent conversation and
 * its thread: once one is gone or expired, the content is discarded and appends resolve
 * `SUBAGENT_CONTENT_GONE`. Expired content is never read.
 *
 * `prepareSubagentContentDeletion` (`~/methods/subagentContent`) is not part of this port: the
 * MongoDB conversation and message methods call it with their own filter when they delete.
 */
import type {
  SubagentContentHead,
  SubagentContentScope,
  SubagentContentBatch,
  SubagentContentAppendResult,
} from '~/types';
import { listPortMethods } from './common';

export interface SubagentContentStore {
  /**
   * Commits the batch at `revision`, then reconciles as `reconcileSubagentContent`. When the
   * seed message or parent conversation is gone, or the thread holds no live lease for the task
   * (with `leaseToken`, that lease), it commits nothing, reconciles and resolves
   * `SUBAGENT_CONTENT_GONE`. Throws for a revision below 1 or sequences that are not a valid
   * range, and when a retry at the same revision carries different bytes.
   */
  appendSubagentContentBatch(
    input: SubagentContentScope & SubagentContentBatch & { leaseToken?: string },
  ): Promise<SubagentContentAppendResult>;
  /**
   * Discards the run's content when its seed message, parent conversation or thread is gone
   * and resolves `SUBAGENT_CONTENT_GONE`; otherwise `ok`. Needs no lease.
   */
  reconcileSubagentContent(scope: SubagentContentScope): Promise<SubagentContentAppendResult>;
  /**
   * The run's latest committed batch (at or below `throughRevision` when given), or `null`
   * when it has none.
   */
  getSubagentContentHead(
    scope: SubagentContentScope,
    throughRevision?: number,
  ): Promise<SubagentContentHead | null>;
  /**
   * The run's committed batches through `throughRevision`, in revision order, from the first
   * that ends after `afterSequence` (from the first batch by default). Throws when a committed
   * batch is incomplete or does not match its digest.
   */
  streamSubagentContentBatches(
    scope: SubagentContentScope,
    throughRevision: number,
    afterSequence?: number,
  ): AsyncIterable<SubagentContentBatch>;
}

/** Every method of {@link SubagentContentStore}, for adapters and conformance checks. */
export const SUBAGENT_CONTENT_STORE_METHODS: ReadonlyArray<keyof SubagentContentStore> =
  listPortMethods<SubagentContentStore>({
    appendSubagentContentBatch: true,
    reconcileSubagentContent: true,
    getSubagentContentHead: true,
    streamSubagentContentBatches: true,
  });
