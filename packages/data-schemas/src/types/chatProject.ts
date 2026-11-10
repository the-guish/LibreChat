import type { TChatProjectsConfig } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';
import type { IConversation } from './convo';

export interface IChatProject {
  _id?: Types.ObjectId;
  name: string;
  description?: string;
  instructions?: string;
  contextRevision?: number;
  file_ids?: string[];
  hasInstructions?: boolean;
  fileCount?: number;
  user: string;
  conversationCount: number;
  lastConversationAt?: Date | null;
  lastConversationId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

export interface IChatProjectDocument extends Omit<IChatProject, '_id'>, Document {}

export type ChatProjectSortBy = 'name' | 'createdAt' | 'lastConversationAt';
export type ChatProjectSortDirection = 'asc' | 'desc';

export type CreateChatProjectInput = {
  name: string;
  description?: string | null;
  instructions?: string;
};

export type UpdateChatProjectInput = Partial<CreateChatProjectInput> & {
  contextRevision?: number;
};

export type ListChatProjectsOptions = {
  cursor?: string | null;
  limit?: number;
  sortBy?: ChatProjectSortBy;
  sortDirection?: ChatProjectSortDirection;
  search?: string;
};

export type ListChatProjectsResult = {
  projects: IChatProject[];
  nextCursor: string | null;
};

export type DeleteChatProjectResult = {
  deletedCount: number;
  modifiedCount: number;
};

export type AssignConversationToProjectResult = {
  conversation: IConversation;
  previousProjectId: string | null;
  projectId: string | null;
};

export type ChatProjectLimits = Pick<
  TChatProjectsConfig,
  'maxFiles' | 'maxInstructionsLength' | 'maxDescriptionLength'
>;
