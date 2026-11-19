/**
 * Test helpers for the services that take the data layer: the ACL service, the DB-backed MCP
 * server configs and the MCP server registry. They build those services from the data methods in
 * a way that works whether a constructor takes the methods (`new AccessControlService(methods)`,
 * `new ServerConfigsDB(methods)`) or, as before, a mongoose instance (with the methods as an
 * optional second argument for the ACL service), so the specs that use them pass on both sides of
 * that change.
 */
import { CacheKeys } from 'librechat-data-provider';
import { createMethods } from '@librechat/data-schemas';
import { AccessControlService } from './accessControlService';
import { userPrincipalsCache } from '~/cache';

type Mongoose = typeof import('mongoose');

/**
 * The data methods the ACL service used to build for itself from a mongoose instance:
 * `createMethods` with the user principals cache.
 */
export function createAccessControlMethods(mongoose: Mongoose): ReturnType<typeof createMethods> {
  return createMethods(mongoose, {
    getCache: (key) => (key === CacheKeys.USER_PRINCIPALS ? userPrincipalsCache() : undefined),
  });
}

/**
 * The ACL service on `methods`: passed as `(methods, methods)`, so a constructor taking
 * `(mongoose, methods?)` uses its second argument and one taking `(methods)` its first.
 */
export function createAccessControlService(
  methods: ReturnType<typeof createMethods>,
): AccessControlService {
  const Service = AccessControlService as unknown as new (
    ...args: unknown[]
  ) => AccessControlService;
  return new Service(methods, methods);
}

/**
 * `methods` that also read as the mongoose instance they were built on (its members through the
 * prototype, the methods as own properties), for a constructor that takes either the instance or
 * the methods (`ServerConfigsDB`, `MCPServersRegistry`).
 */
export function asDataLayer<T extends object>(mongoose: Mongoose, methods: T): Mongoose & T {
  return Object.assign(Object.create(mongoose) as Mongoose, methods);
}
