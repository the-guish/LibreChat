/**
 * Fixtures shared by the `ScheduleStore` run contract suites (`schedule.runs.contract.ts`,
 * `schedule.mcp.contract.ts`): schedules and runs created through the store's own methods (it
 * stores both as given), the stored run of an occurrence, and the outcome calls. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import type { ISchedule, IScheduleRun, RecordRunOutcomeParams } from '~/types';
import type { ContractHarness, RawRecord } from './harness';
import type { ScheduleStore, ScheduleStoreData, ScheduleRunStoreData } from '~/ports/schedule';
import { idOf, readRawWhere, timeOf } from './support';

/** Whether a field reads as unset (absent, or `null` where a backend stores no value). */
export const unset = (value: unknown): boolean => value === undefined || value === null;
/** A fixed occurrence `hours` after 2026-07-20T12:00Z. */
export const occurrence = (hours: number = 0): Date =>
  new Date(Date.parse('2026-07-20T12:00:00.000Z') + hours * 3_600_000);

/** The outcome fields a case gives; the occurrence and the failure threshold default. */
type OutcomeParams = Partial<RecordRunOutcomeParams> & Pick<RecordRunOutcomeParams, 'status'>;

/** The helpers of one suite. */
export interface ScheduleRunFixtures {
  schedules: () => ScheduleStore;
  newId: () => string;
  /** A schedule due a minute ago, of a new owner, `overrides` over it. */
  scheduleData: (overrides?: ScheduleStoreData) => ScheduleStoreData;
  create: (overrides?: ScheduleStoreData) => Promise<ISchedule>;
  /** A started run of the schedule's default occurrence, `overrides` over it. */
  runData: (
    schedule: { id: string; user: unknown },
    overrides?: ScheduleRunStoreData,
  ) => ScheduleRunStoreData;
  insert: (schedule: ISchedule, overrides?: ScheduleRunStoreData) => Promise<IScheduleRun | null>;
  runOf: (scheduleId: string, scheduledFor?: Date) => Promise<RawRecord>;
  runsOf: (scheduleId: string) => Promise<RawRecord[]>;
  live: (id: string) => Promise<ISchedule>;
  ownerOf: (schedule: ISchedule) => string;
  outcome: (schedule: ISchedule, params: OutcomeParams) => RecordRunOutcomeParams;
  record: (schedule: ISchedule, params: OutcomeParams) => Promise<void>;
  skip: (
    schedule: ISchedule,
    status: 'skipped_overlap' | 'skipped_balance',
    overrides?: ScheduleRunStoreData,
    threshold?: number,
  ) => Promise<void>;
}

/** The fixtures of one suite (schedule ids are numbered per suite). */
export function scheduleRunFixtures(harness: ContractHarness): ScheduleRunFixtures {
  const schedules = () => harness.createStores().schedules;
  const newId = () => harness.ids.generate();
  let counter = 0;

  const scheduleData = (overrides: ScheduleStoreData = {}): ScheduleStoreData => ({
    id: `sched-${++counter}`,
    user: newId(),
    name: 'Morning digest',
    prompt: 'Summarize my inbox',
    agent_id: 'agent-test',
    cadence: { frequency: 'daily', hour: 8, minute: 0 },
    timezone: 'America/New_York',
    target: 'new',
    enabled: true,
    nextRunAt: new Date(Date.now() - 60_000),
    ...overrides,
  });
  const create = (overrides: ScheduleStoreData = {}) =>
    schedules().createSchedule(scheduleData(overrides));
  const runData = (
    schedule: { id: string; user: unknown },
    overrides: ScheduleRunStoreData = {},
  ): ScheduleRunStoreData => ({
    scheduleId: schedule.id,
    user: idOf(harness, schedule.user),
    scheduledFor: occurrence(),
    status: 'started',
    firedAt: new Date(),
    ...overrides,
  });
  const insert = (schedule: ISchedule, overrides: ScheduleRunStoreData = {}) =>
    schedules().insertScheduleRun(runData(schedule, overrides));
  /** The run of the occurrence as stored; failing when there is none. */
  const runOf = async (scheduleId: string, scheduledFor: Date = occurrence()) => {
    const [run] = (await readRawWhere(harness, 'scheduleruns', { scheduleId })).filter(
      (row) => timeOf(row.scheduledFor) === scheduledFor.getTime(),
    );
    if (run == null) {
      throw new Error(`run ${scheduleId} @ ${scheduledFor.toISOString()} not found`);
    }
    return run;
  };
  const runsOf = (scheduleId: string) => readRawWhere(harness, 'scheduleruns', { scheduleId });
  /** The schedule through the owner read, failing when it is hidden or gone. */
  const live = async (id: string): Promise<ISchedule> => {
    const schedule = await schedules().getScheduleById(id);
    if (schedule == null) {
      throw new Error(`schedule ${id} not found`);
    }
    return schedule;
  };
  const ownerOf = (schedule: ISchedule) => idOf(harness, schedule.user);
  const outcome = (
    schedule: ISchedule,
    params: Partial<RecordRunOutcomeParams> & Pick<RecordRunOutcomeParams, 'status'>,
  ): RecordRunOutcomeParams => ({
    scheduleId: schedule.id,
    scheduledFor: occurrence(),
    autoDisableAfterFailures: 3,
    ...params,
  });
  const record = (
    schedule: ISchedule,
    params: Partial<RecordRunOutcomeParams> & Pick<RecordRunOutcomeParams, 'status'>,
  ) => schedules().recordRunOutcome(outcome(schedule, params));
  const skip = (
    schedule: ISchedule,
    status: 'skipped_overlap' | 'skipped_balance',
    overrides: ScheduleRunStoreData = {},
    threshold?: number,
  ) =>
    schedules().recordSkippedRun(
      {
        scheduleId: schedule.id,
        user: ownerOf(schedule),
        scheduledFor: occurrence(),
        status,
        ...overrides,
      } as Parameters<ScheduleStore['recordSkippedRun']>[0],
      threshold,
    );

  return {
    schedules,
    newId,
    scheduleData,
    create,
    runData,
    insert,
    runOf,
    runsOf,
    live,
    ownerOf,
    outcome,
    record,
    skip,
  };
}
