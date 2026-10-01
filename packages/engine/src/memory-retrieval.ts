// 07 G2: memory retrieval ranking (§10.3 P0 design: pinned + tags + simple text match, no embeddings). Pure: the
// candidate set comes from the run's memory snapshot, which was taken at intake from `MemoryRepo.retrievable`
// (project id mandatory, approved only — suggestions never reach context, §10.1).
import type { MemoryId, MemoryRecordScope, MemoryScope, MemoryType, Role } from '@relay/contracts';

/** Score given to pinned records (finite so it serializes into the manifest). */
export const PINNED_SCORE = 1_000_000;
/** §10.1 "retrieve selectively": at most this many `run_summary` records per step. */
export const MAX_RUN_SUMMARIES = 2;

/** Type weights of the G2 score. */
const TYPE_WEIGHT: Readonly<Record<MemoryType, number>> = {
  user_rule: 3,
  project_decision: 2,
  source_reference: 1,
  run_summary: 0.5,
};

/** Words that carry no retrieval signal. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it',
  'its', 'not', 'of', 'on', 'or', 'so', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'use', 'was',
  'we', 'were', 'when', 'which', 'will', 'with', 'without', 'you', 'your',
]);

/** One memory record as seen by retrieval (its snapshotted revision). */
export interface RetrievableRecord {
  readonly id: MemoryId;
  readonly revision: number;
  readonly type: MemoryType;
  readonly title: string;
  readonly content: string;
  readonly pinned: boolean;
  readonly scope: MemoryRecordScope;
  /** relPaths of the revision's `file` source refs. */
  readonly sourcePaths: readonly string[];
  /** A `file` source ref's hash differs from the live file (§10.5 "Source changed"). */
  readonly stale: boolean;
}

/** A ranked record. `mandatory` = pinned user_rule (always in context; never a run_summary). */
export interface RankedRecord extends RetrievableRecord {
  readonly score: number;
  readonly mandatory: boolean;
}

/** The ranking query. */
export interface RetrievalQuery {
  readonly goal: string;
  readonly role: Role;
  readonly inputPaths: readonly string[];
}

/** Lowercase tokens split on non-alphanumerics, stopwords and 1-char tokens dropped. */
export function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/** Whether a pinned record is a mandatory rule (pinned user_rule). */
export function isMandatory(r: Pick<RetrievableRecord, 'pinned' | 'type'>): boolean {
  return r.pinned && r.type === 'user_rule';
}

/** G2 score: pinned → {@link PINNED_SCORE}; else 2·|goal ∩ content| + 3·|sourceRef paths ∩ inputPaths| + typeWeight. */
export function scoreRecord(r: RetrievableRecord, goalTokens: ReadonlySet<string>, inputPaths: ReadonlySet<string>): number {
  if (r.pinned) return PINNED_SCORE;
  const text = tokenize(`${r.title} ${r.content}`);
  const paths = r.sourcePaths.filter((p) => inputPaths.has(p)).length;
  return 2 * overlap(goalTokens, text) + 3 * paths + TYPE_WEIGHT[r.type];
}

/**
 * Ranks records by score (desc, then id for determinism). `run_summary` records are never mandatory; only the best
 * {@link MAX_RUN_SUMMARIES} are returned (the rest are reported by {@link excessRunSummaries}).
 */
export function rankMemory(records: readonly RetrievableRecord[], query: RetrievalQuery): RankedRecord[] {
  const goal = tokenize(query.goal);
  const inputs = new Set(query.inputPaths);
  const ranked = records
    .map((r) => ({ ...r, score: scoreRecord(r, goal, inputs), mandatory: isMandatory(r) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let summaries = 0;
  return ranked.filter((r) => r.type !== 'run_summary' || ++summaries <= MAX_RUN_SUMMARIES);
}

/** The run summaries {@link rankMemory} dropped (ranked lower than the first {@link MAX_RUN_SUMMARIES}). */
export function excessRunSummaries(records: readonly RetrievableRecord[], ranked: readonly RankedRecord[]): RetrievableRecord[] {
  const kept = new Set(ranked.map((r) => r.id));
  return records.filter((r) => !kept.has(r.id));
}

/** Whether a record's role scope covers `role`. */
export function scopeCovers(scope: MemoryRecordScope, role: Role): boolean {
  return scope.roles === 'all' || scope.roles.includes(role);
}

/**
 * Step `memoryScope` filter (02 B4): `types` keeps listed types; `roles: 'step_role'` keeps records whose role scope
 * covers the step's role. Pinned user_rules pass regardless (07 G1 step 3).
 */
export function applyMemoryScope<T extends RetrievableRecord>(records: readonly T[], scope: MemoryScope, role: Role): T[] {
  return records.filter((r) => {
    if (isMandatory(r)) return true;
    if (!scope.types.includes(r.type)) return false;
    return scope.roles === 'all' || scopeCovers(r.scope, role);
  });
}
