import { Document, Types } from 'mongoose';
import type { MCPServerDB } from 'librechat-data-provider';

/**
 * Mongoose document interface for MCP Server
 * Extends API interface with Mongoose-specific database fields
 */
export interface MCPServerDocument
  extends Omit<MCPServerDB, 'author' | '_id'>,
    Document<Types.ObjectId> {
  normalizedServerName: string;
  author: Types.ObjectId; // ObjectId reference in DB (vs string in API)
  tenantId?: string;
}

/** A principal holding view access on an MCP server, as its view ACL names it. */
export interface MCPServerViewerEntry {
  principalType: string;
  principalId?: string;
}

/** A view-ACL principal as stored or as already read by a caller. */
export interface MCPServerViewerPrincipal {
  principalType: string;
  principalId?: { toString(): string } | string | null;
}

/** An MCP server removed with its owner's account. */
export interface ErasableMCPServer {
  id: string;
  serverName: string;
}
