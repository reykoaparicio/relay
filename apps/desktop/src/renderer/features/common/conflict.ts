// CONFLICT copy (10 J2): a CONFLICT carries `details.reason` (02 §B0, engine `errors.conflict({ reason, … })`). Each
// reason gets a specific message and the action that helps. Only a *stale* conflict (the item changed since it was
// loaded: a revision mismatch or `draft_changed`) offers "Reload", and only when the page supplies a reload handler;
// every other CONFLICT (memory_conflict, profile_in_use, active_run, …) is not fixed by reloading.
import type { AppError } from '@relay/contracts';
import { isAppErrorException } from '../../api/client';

export type ConflictKind =
  /** The item changed since it was loaded (revision / updatedAt mismatch, `draft_changed`, `draft_exists`). */
  | 'stale'
  /** The result would leave two approved memory records in conflict (`details.conflictsWith`). */
  | 'memory_conflict'
  /** The record was superseded by a conflict resolution (`details.supersededById`). */
  | 'memory_superseded'
  /** The profile is named by workflow drafts or validated versions (`details.workflowIds`). */
  | 'profile_in_use'
  /** The project has a run that has not ended (`details.runIds`). */
  | 'active_run'
  /** Any other state conflict: the specific message is in `message`. */
  | 'other';

export interface ConflictWorkflow {
  readonly id: string;
  readonly name: string | null;
  readonly version: number | 'draft' | null;
}

export interface ConflictCopy {
  readonly kind: ConflictKind;
  readonly reason: string | null;
  readonly title: string;
  readonly message: string;
  /** Reloading the item helps (and is the only case a Reload button may be shown). */
  readonly stale: boolean;
  /** Memory ids the change conflicts with (memory_conflict / memory_superseded). */
  readonly conflictsWith: readonly string[];
  /**
   * Workflows using the profile (profile_in_use): `details.workflows` (`{ id, name, version }`, from a rename) or
   * `details.workflowIds` (from a delete). `name` / `version` are null when the CONFLICT carries only the id.
   */
  readonly workflows: readonly ConflictWorkflow[];
  /** Active run ids (active_run). */
  readonly runIds: readonly string[];
  /** The server's current revision, when the CONFLICT carries it. */
  readonly currentRevision: number | null;
}

/** Names for ids in the copy (memory titles, workflow names). Unknown ids are described generically. */
export interface ConflictNames {
  readonly recordTitle?: (id: string) => string | undefined;
  readonly workflowName?: (id: string) => string | undefined;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** `details.workflows` (`[{ id, name, version }]`) or `details.workflowIds` (`[id]`). */
function workflowsOf(details: Readonly<Record<string, unknown>>): ConflictWorkflow[] {
  const rich = details['workflows'];
  if (Array.isArray(rich)) {
    return rich.flatMap((w): ConflictWorkflow[] => {
      if (typeof w !== 'object' || w === null) return [];
      const o = w as Record<string, unknown>;
      if (typeof o['id'] !== 'string') return [];
      const v = o['version'];
      return [
        {
          id: o['id'],
          name: typeof o['name'] === 'string' ? o['name'] : null,
          version: typeof v === 'number' || v === 'draft' ? v : null,
        },
      ];
    });
  }
  return stringList(details['workflowIds']).map((id) => ({ id, name: null, version: null }));
}

function quotedList(items: readonly string[]): string {
  const q = items.map((t) => `“${t}”`);
  if (q.length <= 1) return q.join('');
  return `${q.slice(0, -1).join(', ')} and ${q.at(-1) ?? ''}`;
}

/** The AppError of a CONFLICT, else null. */
export function conflictErrorOf(e: unknown): AppError | null {
  if (!isAppErrorException(e) || e.appError.code !== 'CONFLICT') return null;
  return e.appError;
}

/** `details.reason` of a CONFLICT, else null. */
export function conflictReason(e: unknown): string | null {
  const reason = conflictErrorOf(e)?.details?.['reason'];
  return typeof reason === 'string' ? reason : null;
}

/** True for a CONFLICT that means "the item changed since it was loaded" (reloading helps). */
export function isStaleConflict(e: unknown): boolean {
  const c = conflictCopy(e);
  return c !== null && c.stale;
}

const STALE_REASONS: ReadonlySet<string> = new Set(['draft_changed', 'draft_exists']);

const OTHER_COPY: Readonly<Record<string, { readonly title: string; readonly message: string }>> = {
  idempotency_key_reused: {
    title: 'This request was already used for a different action',
    message: 'Nothing was changed. Submit again to send it as a new request.',
  },
  intent_in_flight: {
    title: 'Another request is still in progress',
    message: 'Wait for it to finish, then try again.',
  },
  run_terminal: { title: 'This run has already ended', message: 'It can no longer be changed. Its report and ledger are kept.' },
  run_not_running: { title: 'This run is not running', message: 'Only a running run can be paused.' },
  run_not_terminal: { title: 'This run has not ended yet', message: 'The report is available once the run ends.' },
  already_decided: { title: 'This approval was already decided', message: 'The run continues from that decision.' },
  run_not_awaiting_approval: { title: 'This run is no longer waiting for approval', message: 'Nothing was decided.' },
  duplicate_in_flight: { title: 'This decision is already being applied', message: 'Wait for it to finish.' },
  already_archived: { title: 'This project is already archived', message: 'Nothing was changed.' },
  project_archived: { title: 'This project is archived', message: 'An archived project cannot start runs.' },
  root_already_used: { title: 'This folder is already a Relay project', message: 'Open the existing project instead.' },
  invalid_memory_transition: {
    title: 'This record can no longer do that',
    message: 'Its status changed (for example it was archived, approved or rejected elsewhere).',
  },
  unknown_attempts: {
    title: 'A request has an unknown outcome',
    message: 'Decide each request with an unknown outcome first.',
  },
  decision_not_applicable: { title: 'This action no longer applies to the run', message: 'The run state changed.' },
  step_not_ready: { title: 'This step is not ready', message: 'The run state changed.' },
  step_not_failed: { title: 'Only a failed step can be retried', message: 'The step state changed.' },
  attempt_not_unknown: { title: 'This request already has an outcome', message: 'Nothing was changed.' },
};

/**
 * Maps a CONFLICT to specific copy, or null when `e` is not a CONFLICT. A CONFLICT without a reason (a plain
 * `expectedRevision` / `expectedUpdatedAt` mismatch, possibly with `details.currentRevision`) is stale.
 */
export function conflictCopy(e: unknown, names: ConflictNames = {}): ConflictCopy | null {
  const err = conflictErrorOf(e);
  if (err === null) return null;
  const details = err.details ?? {};
  const reason = typeof details['reason'] === 'string' ? details['reason'] : null;
  const currentRevision = typeof details['currentRevision'] === 'number' ? details['currentRevision'] : null;
  const base = { reason, conflictsWith: [], workflows: [], runIds: [], currentRevision } as const;

  if (reason === null || STALE_REASONS.has(reason)) {
    return {
      ...base,
      kind: 'stale',
      stale: true,
      title: reason === 'draft_changed' || reason === 'draft_exists' ? 'The draft changed in another session' : 'This item changed since it was loaded',
      message:
        currentRevision === null
          ? 'Relay did not overwrite it. Your edits are kept; compare them with the saved version before saving again.'
          : `Relay did not overwrite it (it is now revision ${String(currentRevision)}). Your edits are kept; compare them with the saved version before saving again.`,
    };
  }
  if (reason === 'memory_conflict' || reason === 'memory_superseded') {
    const ids = stringList(details['conflictsWith']);
    const superseded = typeof details['supersededById'] === 'string' ? details['supersededById'] : null;
    const all = superseded !== null && !ids.includes(superseded) ? [superseded, ...ids] : ids;
    const titles = all.map((id) => names.recordTitle?.(id) ?? 'another approved record');
    if (reason === 'memory_superseded') {
      return {
        ...base,
        kind: 'memory_superseded',
        stale: false,
        conflictsWith: all,
        title: `Superseded by ${quotedList(titles) || 'another record'}`,
        message: 'A conflict resolution replaced this record. Edit the record that replaced it, or resolve the two records again.',
      };
    }
    return {
      ...base,
      kind: 'memory_conflict',
      stale: false,
      conflictsWith: all,
      title: `Conflicts with ${quotedList(titles) || 'an approved record'}`,
      message:
        'Relay never keeps two conflicting approved records. Nothing was saved: combine the two records, or resolve which one to keep.',
    };
  }
  if (reason === 'profile_in_use') {
    const workflows = workflowsOf(details);
    const list = workflows.map((w) => w.name ?? names.workflowName?.(w.id) ?? 'a workflow');
    return {
      ...base,
      kind: 'profile_in_use',
      stale: false,
      workflows,
      title: 'This profile is used by workflows',
      message: `${list.length === 0 ? 'A workflow draft or validated version' : `Used by ${quotedList([...new Set(list)])}`} names this profile, so Relay refuses to rename or delete it. Choose another profile in those workflows first. Nothing was changed.`,
    };
  }
  if (reason === 'active_run') {
    const ids = stringList(details['runIds']);
    return {
      ...base,
      kind: 'active_run',
      stale: false,
      runIds: ids,
      title: 'This project has an active run',
      message: 'A project cannot be archived while a run has not ended. Stop the run or wait for it to finish, then archive. Nothing was changed.',
    };
  }
  const known = OTHER_COPY[reason];
  return {
    ...base,
    kind: 'other',
    stale: false,
    title: known?.title ?? 'This action conflicts with the current state',
    message: known?.message ?? err.userMessage,
  };
}
