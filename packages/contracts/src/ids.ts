import { z } from 'zod';
import type { Brand } from './brand.js';
import type { Clock } from './time.js';

/** Prefix of every entity id (`<prefix>_<ULID>`). One entry per id alias; nothing else invents id names (02 §B1). */
export const ID_PREFIX = {
  project: 'prj',
  workflow: 'wfl',
  workflowVersion: 'wfv',
  profile: 'prf',
  run: 'run',
  stepRun: 'stp',
  attempt: 'att',
  ledger: 'led',
  artifact: 'art',
  approval: 'apr',
  memory: 'mem',
  memoryRevision: 'mrv',
  event: 'evt',
  credentialRef: 'crd',
  selection: 'sel',
  correlation: 'cor',
} as const;

/** Key of {@link ID_PREFIX}. */
export type IdPrefixKey = keyof typeof ID_PREFIX;

/** `prj_…` */
export type ProjectId = Brand<string, 'ProjectId'>;
/** `wfl_…` */
export type WorkflowId = Brand<string, 'WorkflowId'>;
/** `wfv_…` */
export type WorkflowVersionId = Brand<string, 'WorkflowVersionId'>;
/** `prf_…` */
export type ProfileId = Brand<string, 'ProfileId'>;
/** `run_…` */
export type RunId = Brand<string, 'RunId'>;
/** `stp_…` one `step_runs` row (a step key × revision × retry). */
export type StepRunId = Brand<string, 'StepRunId'>;
/** `att_…` */
export type AttemptId = Brand<string, 'AttemptId'>;
/** `led_…` */
export type LedgerEntryId = Brand<string, 'LedgerEntryId'>;
/** `art_…` */
export type ArtifactId = Brand<string, 'ArtifactId'>;
/** `apr_…` */
export type ApprovalId = Brand<string, 'ApprovalId'>;
/** `mem_…` */
export type MemoryId = Brand<string, 'MemoryId'>;
/** `mrv_…` */
export type MemoryRevisionId = Brand<string, 'MemoryRevisionId'>;
/** `evt_…` */
export type EventId = Brand<string, 'EventId'>;
/** `crd_…` */
export type CredentialRefId = Brand<string, 'CredentialRefId'>;
/** `sel_…` main-only directory selection token. */
export type SelectionId = Brand<string, 'SelectionId'>;
/** `cor_…` log correlation id carried by `INTERNAL` errors. */
export type CorrelationId = Brand<string, 'CorrelationId'>;

/** Maps an {@link ID_PREFIX} key to its branded id alias. */
export interface IdTypes {
  project: ProjectId;
  workflow: WorkflowId;
  workflowVersion: WorkflowVersionId;
  profile: ProfileId;
  run: RunId;
  stepRun: StepRunId;
  attempt: AttemptId;
  ledger: LedgerEntryId;
  artifact: ArtifactId;
  approval: ApprovalId;
  memory: MemoryId;
  memoryRevision: MemoryRevisionId;
  event: EventId;
  credentialRef: CredentialRefId;
  selection: SelectionId;
  correlation: CorrelationId;
}

/** The branded id alias for prefix key `P`. */
export type IdOf<P extends IdPrefixKey> = IdTypes[P];

/** Crockford base32 alphabet used by ULIDs (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Regex body for a 26-char ULID. The first char is 0-7: a 48-bit timestamp never exceeds `7ZZZZZZZZZ`. */
export const ULID_PATTERN = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_BYTES = 10;
const MAX_ULID_TIME = 2 ** 48 - 1;
const RANDOM_LIMIT = 1n << 80n;

/** Regex matching a full id for prefix key `p`. */
export function idPattern(p: IdPrefixKey): RegExp {
  return new RegExp(`^${ID_PREFIX[p]}_${ULID_PATTERN}$`);
}

/** Type guard: `value` is a well-formed id with prefix `p`. */
export function isIdOf<P extends IdPrefixKey>(p: P, value: unknown): value is IdOf<P> {
  return typeof value === 'string' && idPattern(p).test(value);
}

/** Zod schema for an id with prefix `p`; the output is the branded alias. */
export const idSchema = <P extends IdPrefixKey>(p: P) =>
  z
    .string()
    .regex(idPattern(p), `must be a ${ID_PREFIX[p]}_ id`)
    .transform((s) => s as IdOf<P>);

/** Id generator port (00b §2.4). */
export interface IdGen {
  next<P extends IdPrefixKey>(p: P): IdOf<P>;
}

function encodeTime(ms: number): string {
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_LEN; i += 1) {
    const mod = rest % 32;
    out = `${CROCKFORD.charAt(mod)}${out}`;
    rest = (rest - mod) / 32;
  }
  return out;
}

function encodeRandom(value: bigint): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out = `${CROCKFORD.charAt(Number(rest & 31n))}${out}`;
    rest >>= 5n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) {
    v = (v << 8n) | BigInt(b);
  }
  return v;
}

/**
 * Creates a monotonic ULID-based id generator. Pure apart from the injected clock and random source.
 * Within one millisecond (or if the clock goes backwards) the random part is incremented, so ids stay sortable.
 * @throws RangeError when the clock is outside the ULID time range, the random source returns the wrong length,
 * or the monotonic random part overflows within one millisecond.
 */
export function createIdGen(clock: Clock, random: (n: number) => Uint8Array): IdGen {
  let lastTime = -1;
  let lastRandom = 0n;
  const nextBody = (): string => {
    const now = clock.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_ULID_TIME) {
      throw new RangeError('clock value outside the ULID time range');
    }
    if (now <= lastTime) {
      lastRandom += 1n;
      if (lastRandom >= RANDOM_LIMIT) {
        throw new RangeError('ULID random part overflowed within one millisecond');
      }
    } else {
      const bytes = random(RANDOM_BYTES);
      if (bytes.length !== RANDOM_BYTES) {
        throw new RangeError(`random source must return ${String(RANDOM_BYTES)} bytes`);
      }
      lastTime = now;
      lastRandom = bytesToBigInt(bytes);
    }
    return `${encodeTime(lastTime)}${encodeRandom(lastRandom)}`;
  };
  return {
    next<P extends IdPrefixKey>(p: P): IdOf<P> {
      return `${ID_PREFIX[p]}_${nextBody()}` as IdOf<P>;
    },
  };
}
