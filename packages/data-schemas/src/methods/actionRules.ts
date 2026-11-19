/**
 * The action store's database-neutral rules (`ActionStore`, `~/ports/action`), shared by every
 * backend: the MongoDB methods (`./action`) and the PostgreSQL store
 * (`adapters/postgres/stores/action.ts`). Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import type { ActionQuery, IAction } from '~/types';
import { buildFilter, type FieldMap } from '~/utils/criteria';

const sensitiveFields = ['api_key', 'oauth_client_id', 'oauth_client_secret'] as const;

const ACTION_FIELDS: FieldMap<ActionQuery> = {
  actionId: 'action_id',
  agentId: 'agent_id',
  assistantId: 'assistant_id',
  user: 'user',
};

/** Translates domain action criteria into a filter of the store query language. */
export function actionCriteria(query: ActionQuery): Record<string, unknown> {
  return buildFilter<ActionQuery, Record<string, unknown>>(query, ACTION_FIELDS);
}

/** Removes the credentials from each action's metadata, in place. */
export function removeActionSecrets(actions: Array<Pick<IAction, 'metadata'>>): void {
  for (let i = 0; i < actions.length; i++) {
    const metadata = actions[i].metadata;
    if (!metadata) {
      continue;
    }

    for (const field of sensitiveFields) {
      if (metadata[field]) {
        delete metadata[field];
      }
    }
  }
}
