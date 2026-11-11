import type { PrincipalType } from 'librechat-data-provider';
import type { StoreIdValue } from '@librechat/data-schemas';

export interface ResolvedPrincipal {
  principalType: PrincipalType;
  principalId?: string | StoreIdValue;
}
