import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, ErrorView, InlineAlert } from '../../components/ui';
import { errorTitle, toViewError } from '../../api/errors';
import { runLabel } from '../runs/run-display';
import { paths } from '../shell/paths';
import { conflictCopy, conflictErrorOf } from './conflict';
import type { ConflictCopy, ConflictNames } from './conflict';
import { useNextAction } from './useNextAction';
import type { NextActionHandlers } from './useNextAction';

export interface MutationErrorProps {
  /** The failed mutation's error; nothing renders when null/undefined. */
  readonly error: unknown;
  /**
   * Page handlers for next actions (e.g. `reload` → refetch the queries the form depends on). Unhandled actions route
   * as usual; an unhandled `reload` is never rendered (a Reload button that refetches nothing would be dead).
   */
  readonly handlers?: NextActionHandlers;
  /** Names for ids carried by a CONFLICT (memory titles, workflow names). */
  readonly names?: ConflictNames;
  /** Project for links in a CONFLICT (workflows that use a profile, the active run). */
  readonly projectId?: string | undefined;
  /** Extra actions for a CONFLICT (e.g. "Combine with …" for a memory conflict). */
  readonly conflictActions?: ReactNode;
}

/**
 * The error of a command: the specific copy of a CONFLICT (`ConflictNotice`), otherwise an ErrorView with the error's
 * next actions (any other code, including an INTERNAL `not_implemented` from a future stubbed runner channel).
 */
export function MutationError({ error, handlers = {}, names, projectId, conflictActions }: MutationErrorProps) {
  const onAction = useNextAction(handlers);
  if (error === null || error === undefined) return null;
  const copy = conflictCopy(error, names);
  if (copy !== null) {
    return (
      <ConflictNotice
        copy={copy}
        correlationId={conflictErrorOf(error)?.correlationId}
        projectId={projectId}
        onReload={handlers.reload}
        actions={conflictActions}
        workflowName={names?.workflowName}
      />
    );
  }
  const view = toViewError(error);
  const title = errorTitle(view);
  // `reload` without a handler would do nothing: drop it rather than render a dead button.
  const shown =
    handlers.reload === undefined
      ? { ...view, nextAction: view.nextAction === 'reload' ? ('none' as const) : view.nextAction, alternatives: view.alternatives.filter((a) => a !== 'reload') }
      : view;
  return <ErrorView error={shown} {...(title === view.userMessage ? {} : { title })} onAction={onAction} />;
}

export interface ConflictNoticeProps {
  readonly copy: ConflictCopy;
  readonly correlationId?: string | undefined;
  readonly projectId?: string | undefined;
  /** Refetches the queries the form depends on. Shown as "Reload" only for a stale conflict. */
  readonly onReload?: (() => void) | undefined;
  readonly actions?: ReactNode;
  readonly workflowName?: ((id: string) => string | undefined) | undefined;
}

/** A CONFLICT with its specific message, the ids it names as links, and only the actions that help. */
export function ConflictNotice({ copy, correlationId, projectId, onReload, actions, workflowName }: ConflictNoticeProps) {
  const reload =
    copy.stale && onReload !== undefined ? (
      <Button size="sm" onClick={onReload}>
        Reload
      </Button>
    ) : null;
  const hasActions = reload !== null || (actions !== undefined && actions !== null);
  return (
    <InlineAlert
      tone={copy.stale ? 'warning' : 'danger'}
      title={copy.title}
      {...(hasActions
        ? {
            actions: (
              <>
                {actions}
                {reload}
              </>
            ),
          }
        : {})}
    >
      <p>{copy.message}</p>
      {copy.workflows.length === 0 ? null : (
        <ul className="small" style={{ margin: 0, paddingLeft: 16 }} aria-label="Workflows using this profile">
          {copy.workflows.map((w) => {
            const name = w.name ?? workflowName?.(w.id) ?? 'Workflow';
            const label = w.version === null ? name : `${name} (${w.version === 'draft' ? 'draft' : `v${String(w.version)}`})`;
            return <li key={`${w.id}:${String(w.version)}`}>{projectId === undefined ? label : <Link to={paths.workflow(projectId, w.id)}>{label}</Link>}</li>;
          })}
        </ul>
      )}
      {copy.runIds.length === 0 ? null : (
        <ul className="small" style={{ margin: 0, paddingLeft: 16 }} aria-label="Active runs">
          {copy.runIds.map((id) => (
            <li key={id}>{projectId === undefined ? runLabel(id) : <Link to={paths.run(projectId, id)}>{runLabel(id)}</Link>}</li>
          ))}
        </ul>
      )}
      <p className="subtle">
        Error code <code>CONFLICT</code>
        {copy.reason === null ? null : (
          <>
            {' '}· <code>{copy.reason}</code>
          </>
        )}
        {correlationId === undefined ? null : (
          <>
            {' '}· reference <code>{correlationId}</code>
          </>
        )}
      </p>
    </InlineAlert>
  );
}
