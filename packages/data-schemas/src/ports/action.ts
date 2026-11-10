/**
 * Action store port: the OpenAPI actions attached to agents and assistants. Nothing here may
 * import `mongoose`. Signatures are copied verbatim from `ActionMethods` (`~/methods/action`);
 * `action.spec.ts` fails the typecheck if the two drift. Criteria are `ActionQuery` domain
 * fields, combined with AND; an array matches any of its entries.
 *
 * Known leak kept for now so callers stay unchanged: `IAction` extends mongoose's `Document`
 * (its `user` is an ObjectId), and `updateAction` takes a `Partial<IAction>` field patch.
 */
import type { ActionQuery, IAction } from '~/types';
import { listPortMethods } from './common';

export interface ActionStore {
  /**
   * The actions matching the criteria. Unless `includeSensitive`, the API key and OAuth client
   * credentials are removed from their metadata.
   */
  getActions(query: ActionQuery, includeSensitive?: boolean): Promise<IAction[]>;
  /**
   * Sets the given fields on the first action matching the criteria, creating it when there is
   * none; resolves to it updated.
   */
  updateAction(query: ActionQuery, updateData: Partial<IAction>): Promise<IAction | null>;
  /** Deletes the first action matching the criteria and resolves to it, or `null`. */
  deleteAction(query: ActionQuery): Promise<IAction | null>;
  /** Deletes every action matching the criteria; resolves how many. */
  deleteActions(query: ActionQuery): Promise<number>;
}

/** Every method of {@link ActionStore}, for adapters and conformance checks. */
export const ACTION_STORE_METHODS: ReadonlyArray<keyof ActionStore> = listPortMethods<ActionStore>({
  getActions: true,
  updateAction: true,
  deleteAction: true,
  deleteActions: true,
});
