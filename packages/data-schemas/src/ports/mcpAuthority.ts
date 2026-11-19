/**
 * MCP authority store port: authority proofs for MCP servers. A proof pins, from one consistent
 * snapshot of the database, everything that entitles a user to use a set of MCP servers (the
 * user and their role, groups and config overrides, each server's source, the ACL entries and
 * agents that grant access to it, its stored credentials and OAuth grant), so that a later check
 * can tell whether any of it changed. Nothing here may import `mongoose`. Signatures are those of
 * `MCPAuthorityDatabaseMethods` (`~/types/mcpAuthority`) without the optional `session` key of
 * their inputs, a MongoDB session to run the snapshot transaction on: no caller outside tests
 * passes one, and the MongoDB methods start their own session when none is given (they refuse
 * one already in a transaction). `mcpAuthority.spec.ts` fails the typecheck if the MongoDB
 * methods stop satisfying these signatures.
 *
 * Contract common to both methods:
 * - Both read one consistent snapshot of the user, role, group, config, MCP server, agent, ACL
 *   entry, plugin credential and token records involved; an adapter reads them itself. The
 *   tenant in the current async context must be the user's (`tenantId`, or none), or the proof
 *   is unavailable.
 * - Both reject with `MCPAuthorityProofError` (exported from this package), whose `reason` says
 *   why: malformed input (`malformed_input`, e.g. more than `MAX_MCP_AUTHORITY_TARGETS` targets),
 *   a snapshot that cannot be read (`proof_unavailable`), or what changed or was revoked.
 */
import type {
  MCPAuthorityProofV1,
  MCPAuthorityAssertInput,
  MCPAuthorityResolveInput,
} from '~/types';
import { listPortMethods } from './common';

/** {@link MCPAuthorityResolveInput} without the MongoDB session. */
export type MCPAuthorityStoreResolveInput = Omit<MCPAuthorityResolveInput, 'session'>;
/** {@link MCPAuthorityAssertInput} without the MongoDB session. */
export type MCPAuthorityStoreAssertInput = Omit<MCPAuthorityAssertInput, 'session'>;

export interface MCPAuthorityStore {
  /**
   * Proves the user's current authority over each target server, under the boot revision
   * `boot`. Rejects when a target's expected source, credential or OAuth grant revision is no
   * longer current, or the user may not use it.
   */
  resolveMCPAuthorityProof(input: MCPAuthorityStoreResolveInput): Promise<MCPAuthorityProofV1>;
  /** Resolves when every proof is still current under `boot`; rejects with what changed. */
  assertMCPAuthorityProofsCurrent(input: MCPAuthorityStoreAssertInput): Promise<void>;
}

/** Every method of {@link MCPAuthorityStore}, for adapters and conformance checks. */
export const MCP_AUTHORITY_STORE_METHODS: ReadonlyArray<keyof MCPAuthorityStore> =
  listPortMethods<MCPAuthorityStore>({
    resolveMCPAuthorityProof: true,
    assertMCPAuthorityProofsCurrent: true,
  });
