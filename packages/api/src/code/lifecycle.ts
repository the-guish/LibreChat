import { EModelEndpoint, ResourceType } from 'librechat-data-provider';
import { getDataStoreBackend, logger, runAsSystem } from '@librechat/data-schemas';
import type { AclEntryStore, AppConfig, CodeEnvironmentStore } from '@librechat/data-schemas';
import type { CodeBridgeFetch } from './bridge';
import { readCodeBridgeSecret, revokeCodeBridgeWorker } from './bridge';
import { isLeader } from '~/cluster';

const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_LEASE_MS = 2 * 60_000;
const REGISTRATION_STALE_MS = 5 * 60_000;
const REGISTRATION_RETRY_MS = 5 * 60_000;
const REVOCATION_RETRY_MS = 5 * 60_000;
let reconcileTimer: NodeJS.Timeout | undefined;
let reconcileInFlight: Promise<void> | undefined;

/**
 * The data methods the lifecycle reconciler runs on (the code environment store's removal and
 * reconciliation steps, and the permission deletes): the composition root's (`~/models` in the
 * server), or the result of `createMethods(...)`.
 */
export type CodeEnvironmentLifecycleMethods = Pick<
  CodeEnvironmentStore,
  | 'sweepExpiredCodeEnvironmentReferences'
  | 'findExpiredCodeEnvironmentRemovals'
  | 'beginCodeEnvironmentRemoval'
  | 'isCodeEnvironmentReferencedByAgent'
  | 'cancelCodeEnvironmentRemoval'
  | 'commitCodeEnvironmentRemoval'
  | 'deleteCodeEnvironmentById'
  | 'findStaleCodeEnvironmentRegistrations'
  | 'claimStaleCodeEnvironmentRegistration'
  | 'deferCodeEnvironmentRegistration'
  | 'deleteStaleCodeEnvironmentRegistration'
  | 'findCommittedCodeEnvironmentDeletions'
  | 'findOrphanedCodeEnvironments'
  | 'requestOrphanedCodeEnvironmentRevocations'
  | 'deleteUserCodeEnvironments'
  | 'findCodeEnvironmentRevocationCandidates'
  | 'claimCodeEnvironmentRevocation'
  | 'deferCodeEnvironmentRevocation'
> &
  Pick<AclEntryStore, 'deleteAclEntries'>;

/** The data methods the worker revocation at an account deletion runs on. */
export type CodeEnvironmentWorkerRevocationMethods = Pick<
  CodeEnvironmentStore,
  | 'findCodeEnvironmentsByCreator'
  | 'beginCodeEnvironmentWorkerRevocations'
  | 'commitCodeEnvironmentWorkerRevocation'
  | 'recordCodeEnvironmentWorkerRevocationError'
>;

export async function reconcileCodeEnvironmentLifecycle({
  db,
  readSecret = readCodeBridgeSecret,
  fetchImpl,
  limit = 25,
}: {
  db: CodeEnvironmentLifecycleMethods;
  readSecret?: (name: string) => string | undefined;
  fetchImpl?: CodeBridgeFetch;
  limit?: number;
}): Promise<void> {
  await runAsSystem(async () => {
    const now = new Date();
    // Persist progress across leader changes and include old-replica writes on each sweep.
    if (!(await db.sweepExpiredCodeEnvironmentReferences(now, limit))) return;
    const expiredRemovals = await db.findExpiredCodeEnvironmentRemovals(now, limit);
    for (const candidate of expiredRemovals) {
      const environment = await db.beginCodeEnvironmentRemoval(candidate._id);
      if (environment == null || environment.deletionLeaseId == null) continue;
      const leaseId = environment.deletionLeaseId;
      if (
        await db.isCodeEnvironmentReferencedByAgent(environment.environmentId, environment.tenantId)
      ) {
        await db.cancelCodeEnvironmentRemoval(environment._id, leaseId);
        continue;
      }
      try {
        if (environment.workerPrincipal?.type === 'user') {
          const tokenEnv = environment.revocationTokenEnv;
          const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
          if (!token || environment.workerId == null) continue;
          await revokeCodeBridgeWorker({
            baseURL: environment.baseURL,
            token,
            workerId: environment.workerId,
            fetchImpl,
          });
        }
        await db.commitCodeEnvironmentRemoval(environment._id, leaseId);
        await db.deleteAclEntries({
          resourceType: ResourceType.CODE_ENVIRONMENT,
          resourceId: environment._id,
        });
        await db.deleteCodeEnvironmentById(environment._id);
      } catch (error) {
        logger.error('[code-environments] interrupted removal reconciliation failed:', error);
      }
    }
    const staleRegistration = new Date(Date.now() - REGISTRATION_STALE_MS);
    const registrationCandidates = await db.findStaleCodeEnvironmentRegistrations(
      staleRegistration,
      now,
      limit,
    );
    const ids = getDataStoreBackend().ids;
    for (const candidate of registrationCandidates) {
      const leaseId = ids.generate();
      const environment = await db.claimStaleCodeEnvironmentRegistration(
        candidate._id,
        staleRegistration,
        leaseId,
        RECONCILE_LEASE_MS,
      );
      if (environment == null) continue;
      const deferRegistration = async (): Promise<void> => {
        await db.deferCodeEnvironmentRegistration(
          environment._id,
          leaseId,
          new Date(Date.now() + REGISTRATION_RETRY_MS),
        );
      };
      const tokenEnv = environment.revocationTokenEnv;
      const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
      if (environment.workerId != null && environment.workerPrincipal?.type !== 'deployment') {
        if (!token) {
          await deferRegistration();
          continue;
        }
        try {
          await revokeCodeBridgeWorker({
            baseURL: environment.baseURL,
            token,
            workerId: environment.workerId,
            fetchImpl,
          });
        } catch {
          await deferRegistration();
          continue;
        }
      }
      await db.deleteAclEntries({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: environment._id,
      });
      await db.deleteStaleCodeEnvironmentRegistration(environment._id, leaseId);
    }

    const committedDeletions = await db.findCommittedCodeEnvironmentDeletions(limit);
    for (const environment of committedDeletions) {
      await db.deleteAclEntries({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: environment._id,
      });
      await db.deleteCodeEnvironmentById(environment._id);
    }

    /** A failed marker write after an account deletion must not strand live worker
     * credentials. The missing owner is itself durable retry intent, so discover
     * unmarked orphans independently of the account-deletion request path. */
    const orphanedEnvironments = await db.findOrphanedCodeEnvironments(limit);
    const revocationTargets = orphanedEnvironments.filter(
      ({ workerId, workerPrincipal }) => workerId != null && workerPrincipal?.type === 'user',
    );
    if (revocationTargets.length > 0) {
      await db.requestOrphanedCodeEnvironmentRevocations(
        revocationTargets.map(({ _id }) => _id),
        now,
      );
    }
    for (const creatorId of new Set(
      orphanedEnvironments.map(({ createdBy }) => createdBy.toHexString()),
    )) {
      await db.deleteUserCodeEnvironments(creatorId);
    }

    const candidates = await db.findCodeEnvironmentRevocationCandidates(now, limit);
    for (const candidate of candidates) {
      const leaseId = ids.generate();
      const environment = await db.claimCodeEnvironmentRevocation(
        candidate._id,
        leaseId,
        RECONCILE_LEASE_MS,
      );
      if (environment == null || environment.workerId == null) continue;
      const tokenEnv = environment.revocationTokenEnv;
      const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
      try {
        if (!token) throw new Error('Code environment revocation token is unavailable');
        await revokeCodeBridgeWorker({
          baseURL: environment.baseURL,
          token,
          workerId: environment.workerId,
          fetchImpl,
        });
        await db.deleteAclEntries({
          resourceType: ResourceType.CODE_ENVIRONMENT,
          resourceId: environment._id,
        });
        await db.deleteCodeEnvironmentById(environment._id);
      } catch (error) {
        const message = (error instanceof Error ? error.message : 'Worker revocation failed').slice(
          0,
          500,
        );
        await db.deferCodeEnvironmentRevocation(
          environment._id,
          leaseId,
          message,
          new Date(Date.now() + REVOCATION_RETRY_MS),
        );
      }
    }
  });
}

export function startCodeEnvironmentLifecycleReconciler(
  options: Parameters<typeof reconcileCodeEnvironmentLifecycle>[0],
): void {
  if (reconcileTimer != null) return;
  const run = (): void => {
    if (reconcileInFlight != null) return;
    const current = isLeader()
      .then(async (leader) => {
        if (!leader) return;
        await reconcileCodeEnvironmentLifecycle(options);
      })
      .catch((error) => {
        logger.error('[code-environments] lifecycle reconciliation failed:', error);
      })
      .finally(() => {
        if (reconcileInFlight === current) reconcileInFlight = undefined;
      });
    reconcileInFlight = current;
  };
  run();
  reconcileTimer = setInterval(run, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
}

export async function revokeUserCodeEnvironmentWorkers({
  db,
  userId,
  appConfig,
  readSecret = readCodeBridgeSecret,
  fetchImpl,
}: {
  db: CodeEnvironmentWorkerRevocationMethods;
  userId: string;
  appConfig: AppConfig;
  readSecret?: (name: string) => string | undefined;
  fetchImpl?: CodeBridgeFetch;
}): Promise<number> {
  const environments = await db.findCodeEnvironmentsByCreator(userId);
  const controlPlanes =
    appConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments ?? [];
  const targets = environments.filter(
    (environment) => environment.workerPrincipal?.type === 'user' && environment.workerId != null,
  );
  if (targets.length > 0) {
    await db.beginCodeEnvironmentWorkerRevocations(targets.map(({ _id }) => _id));
  }
  const results = await Promise.allSettled(
    targets.map(async (environment) => {
      const workerId = environment.workerId;
      if (workerId == null) {
        throw new Error(
          `Code environment worker id is unavailable for ${environment.environmentId}`,
        );
      }
      const fallbackControlPlane = controlPlanes.find(
        (candidate) =>
          candidate.id === environment.controlPlaneId &&
          candidate.owner === 'deployment' &&
          candidate.type === 'attached' &&
          candidate.pairing?.allowPrincipalWorkers === true &&
          candidate.baseURL === environment.baseURL,
      );
      const tokenEnv = environment.revocationTokenEnv ?? fallbackControlPlane?.pairing?.tokenEnv;
      const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
      if (!token) {
        throw new Error(
          `Code environment revocation is unavailable for ${environment.environmentId}`,
        );
      }
      await revokeCodeBridgeWorker({
        baseURL: environment.baseURL,
        token,
        workerId,
        fetchImpl,
      });
      return environment.environmentId;
    }),
  );
  let revoked = 0;
  for (const [index, result] of results.entries()) {
    const target = targets[index];
    if (result.status === 'fulfilled') {
      revoked += 1;
      await db.commitCodeEnvironmentWorkerRevocation(target._id);
      continue;
    }
    const failureMessage = (
      result.reason instanceof Error ? result.reason.message : 'Worker revocation failed'
    ).slice(0, 500);
    await db.recordCodeEnvironmentWorkerRevocationError(target._id, failureMessage);
    logger.error(
      `[code-environments] worker revocation failed during committed user deletion: ${userId}`,
      result.reason,
    );
  }
  return revoked;
}
