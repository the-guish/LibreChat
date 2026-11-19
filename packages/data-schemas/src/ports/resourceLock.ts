/**
 * Resource lock store port: expiring leases on a key, held by one owner at a time. Nothing here
 * may import `mongoose`. Signatures are copied verbatim from `ResourceLockMethods`
 * (`~/methods/resourceLock`); `resourceLock.spec.ts` fails the typecheck if the two drift.
 */
import type { ResourceLockAcquireData, ResourceLockReleaseData } from '~/types';
import { listPortMethods } from './common';

export interface ResourceLockStore {
  /**
   * Takes the lease for `key` for `ttlMs`, or takes over one whose holder let it expire. `false`
   * while another owner holds a live lease, or when the store is not ready within `readyWaitMs`.
   */
  acquireResourceLock(data: ResourceLockAcquireData): Promise<boolean>;
  /**
   * Extends the lease only while `ownerId` still holds it unexpired, never moving its expiry
   * backwards. `false` means it was lost and the holder must not proceed.
   */
  renewResourceLock(data: ResourceLockAcquireData): Promise<boolean>;
  /** Releases the lease only for the owner that holds it; for anyone else a no-op (`false`). */
  releaseResourceLock(data: ResourceLockReleaseData): Promise<boolean>;
}

/** Every method of {@link ResourceLockStore}, for adapters and conformance checks. */
export const RESOURCE_LOCK_STORE_METHODS: ReadonlyArray<keyof ResourceLockStore> =
  listPortMethods<ResourceLockStore>({
    acquireResourceLock: true,
    renewResourceLock: true,
    releaseResourceLock: true,
  });
