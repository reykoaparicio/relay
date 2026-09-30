import type { ArtifactKind, Clock, EpochMs, ProjectId, Result } from '@relay/contracts';
import { epochMs } from '@relay/contracts';
import type { ArtifactRow, Db } from './types.js';

/** The slice of the 05 `ArtifactStore` that purge needs (chmod + unlink + tombstone live there, never here). */
export interface ArtifactPurger {
  purge(relPath: string): Promise<Result<{ purgedAt: number }>>;
}

export interface MaintenanceDeps {
  readonly db: Db;
  readonly artifacts: ArtifactPurger;
  readonly clock: Clock;
}

export interface PurgeSummary {
  readonly purgedArtifacts: number;
  /** Artifacts whose file purge failed; they stay unpurged and are retried by the next sweep. */
  readonly failed: number;
}

export interface ProjectHistoryPurgeSummary extends PurgeSummary {
  readonly purgedSnapshots: number;
}

export interface Maintenance {
  /** §10.4 separate project-history purge: snapshot rows, then raw responses and context manifests of its runs. */
  purgeProjectHistory(projectId: ProjectId): Promise<ProjectHistoryPurgeSummary>;
  /** §12.3 retention: purges `raw_response` files older than `retentionDays`. */
  sweepRawResponses(now: EpochMs, retentionDays: number): Promise<PurgeSummary>;
}

const DAY_MS = 86_400_000;
const HISTORY_KINDS: readonly ArtifactKind[] = ['raw_response', 'context_manifest'];

/**
 * C8 purge and retention helpers. File removal and the row update cannot share a transaction, so each artifact is
 * purged first and `purged_at` is set afterwards in its own tx; a crash in between is healed by the next sweep
 * because `purge` is idempotent (03 §C8). The ledger is never touched.
 */
export function createMaintenance(deps: MaintenanceDeps): Maintenance {
  const { db } = deps;

  const purgeFiles = async (rows: readonly ArtifactRow[]): Promise<PurgeSummary> => {
    let purgedArtifacts = 0;
    let failed = 0;
    for (const a of rows) {
      const r = await deps.artifacts.purge(a.relPath);
      if (!r.ok) {
        failed += 1;
        continue;
      }
      const purgedAt = epochMs(r.value.purgedAt);
      db.tx('immediate', (repos) => repos.artifacts.markPurged(a.id, purgedAt));
      purgedArtifacts += 1;
    }
    return { purgedArtifacts, failed };
  };

  return {
    async purgeProjectHistory(projectId) {
      const now = deps.clock.now();
      const purgedSnapshots = db.tx('immediate', (repos) => {
        const { deleted, recordIds } = repos.memory.purgeRunSnapshots(projectId);
        for (const recordId of recordIds) {
          const item = repos.memory.get(recordId);
          repos.memory.recordEvent({
            recordId,
            event: 'history_purged',
            revision: item?.record.currentRevision ?? 1,
            actor: 'user',
            createdAt: now,
          });
        }
        return deleted;
      });
      const rows = db.repos.artifacts
        .listWhere({ projectId, kinds: HISTORY_KINDS, unpurgedOnly: true })
        .filter((a) => a.runId !== null);
      const files = await purgeFiles(rows);
      return { purgedSnapshots, ...files };
    },
    async sweepRawResponses(now, retentionDays) {
      const cutoff = epochMs(Math.max(0, now - retentionDays * DAY_MS));
      const rows = db.repos.artifacts.listWhere({ kinds: ['raw_response'], createdBefore: cutoff, unpurgedOnly: true });
      return purgeFiles(rows);
    },
  };
}
