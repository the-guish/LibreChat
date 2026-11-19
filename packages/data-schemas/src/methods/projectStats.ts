/**
 * Recomputes many chat projects' statistics through a single-project `refresh`, in bounded
 * batches. Database-neutral: nothing here may import `mongoose` or touch a model.
 */
import logger from '~/config/winston';

const PROJECT_STATS_REFRESH_CONCURRENCY = 10;
const PROJECT_STATS_REFRESH_MAX_PASSES = 2;

/**
 * A project dropped here stays wrong forever: its chats are archived, so no retry of
 * archive-all can find them again to recompute against. The likeliest rejection is also
 * the most recoverable one, `refreshChatProjectStatsForUser` giving up after the project
 * changed under every compare-and-set attempt, so failures are collected and replayed
 * once the rest of the run has stopped competing with them.
 */
export async function refreshChatProjectStatsInBatches(
  refresh: (projectId: string) => Promise<unknown>,
  projectIds: Iterable<string>,
): Promise<void> {
  let pending = [...projectIds];
  for (let pass = 0; pass < PROJECT_STATS_REFRESH_MAX_PASSES && pending.length > 0; pass++) {
    const failed: string[] = [];
    for (let index = 0; index < pending.length; index += PROJECT_STATS_REFRESH_CONCURRENCY) {
      const batch = pending.slice(index, index + PROJECT_STATS_REFRESH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((projectId) => refresh(projectId)));
      for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const result = results[resultIndex];
        if (result.status === 'rejected') {
          failed.push(batch[resultIndex]);
          logger.error(
            `[refreshChatProjectStatsInBatches] Failed to refresh project ${batch[resultIndex]}`,
            result.reason,
          );
        }
      }
    }
    pending = failed;
  }

  if (pending.length > 0) {
    logger.error(
      `[refreshChatProjectStatsInBatches] Left ${pending.length} project(s) unreconciled: ${pending.join(', ')}`,
    );
  }
}
