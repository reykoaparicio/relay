import type { SqlDriver } from '../driver.js';
import type { Repos } from '../types.js';
import { createApprovalRepo } from './approvals.js';
import { createArtifactRepo } from './artifacts.js';
import { createAttemptRepo } from './attempts.js';
import { createCatalogRepo } from './catalog.js';
import { createConfigRevisionRepo } from './config-revisions.js';
import { createCredentialRefRepo } from './credentials.js';
import type { RepoDeps } from './deps.js';
import { createEventRepo } from './events.js';
import { createIdempotencyRepo } from './idempotency.js';
import { createLeaseRepo } from './lease.js';
import { createLedgerRepo } from './ledger.js';
import { createMemoryRepo } from './memory.js';
import { createProfileRepo } from './profiles.js';
import { createProjectRepo } from './projects.js';
import { createRunRepo } from './runs.js';
import { createSettingsRepo } from './settings.js';
import { createStepRepo } from './steps.js';
import { createWorkflowRepo } from './workflows.js';

/** Builds every repository over one connection. */
export function createRepos(driver: SqlDriver, deps: RepoDeps): Repos {
  return Object.freeze({
    projects: createProjectRepo(driver, deps),
    settings: createSettingsRepo(driver, deps),
    credentials: createCredentialRefRepo(driver, deps),
    catalog: createCatalogRepo(driver),
    profiles: createProfileRepo(driver, deps),
    workflows: createWorkflowRepo(driver, deps),
    configRevisions: createConfigRevisionRepo(driver, deps),
    runs: createRunRepo(driver, deps),
    steps: createStepRepo(driver, deps),
    attempts: createAttemptRepo(driver),
    ledger: createLedgerRepo(driver, deps),
    artifacts: createArtifactRepo(driver),
    approvals: createApprovalRepo(driver),
    memory: createMemoryRepo(driver, deps),
    events: createEventRepo(driver, deps),
    idempotency: createIdempotencyRepo(driver, deps),
    lease: createLeaseRepo(driver, deps),
  });
}

export type { RepoDeps } from './deps.js';
