// 08 H10: copies the bundled sample project to a fresh folder (never modifying the original, §1.4) and hands the
// runner a `projects.createFromRoot` input with `isDemo: true`. The fixture `.env` is never copied, in dev too.
import { cp, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { err, errors, ok, toDisplayPath } from '@relay/contracts';
import type { InputOf, ProviderId, Result } from '@relay/contracts';

/** Name of the demo project. */
export const SAMPLE_PROJECT_NAME = 'Sample API';
/** $20.00 monthly allowance for the demo project. */
export const SAMPLE_MONTHLY_ALLOWANCE_MICROUSD = 20_000_000;
/** Providers the demo project allows (fake mode reports the real ids, 04 §D8). */
export const SAMPLE_PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'gemini'];

type CreateFromRootInput = InputOf<'relay/v1/projects.createFromRoot'>;

/** A copied sample, ready for `projects.createFromRoot`. */
export interface SampleCopy {
  readonly realpath: string;
  readonly createInput: Omit<CreateFromRootInput, 'idempotencyKey' | 'isDemo'>;
}

/** The sample service. `copySample` is idempotent per key (a retried request reuses its copy). */
export interface SampleService {
  copySample(idempotencyKey: string): Promise<Result<SampleCopy>>;
}

/** Dependencies of {@link createSampleService}. */
export interface SampleDeps {
  /** `process.resourcesPath/sample-api` packaged, `tests/fixtures/sample-api` in dev. */
  readonly sourceDir: string;
  readonly samplesDir: string;
  readonly homeDir: string;
}

const SAMPLE_DIR_RE = /^sample-api-(\d+)$/;

/** The first unused `sample-api-<n>` under `samplesDir`. */
export async function nextSampleDir(samplesDir: string): Promise<string> {
  const names = await readdir(samplesDir).catch(() => [] as string[]);
  const max = names.reduce((m, name) => Math.max(m, Number(SAMPLE_DIR_RE.exec(name)?.[1] ?? 0)), 0);
  return join(samplesDir, `sample-api-${String(max + 1)}`);
}

/** Recursive copy that skips every `.env` file. */
export async function copySampleTree(src: string, dst: string): Promise<void> {
  await cp(src, dst, { recursive: true, errorOnExist: true, force: false, filter: (p) => basename(p) !== '.env' });
}

/** Creates the sample service. */
export function createSampleService(deps: SampleDeps): SampleService {
  const byKey = new Map<string, SampleCopy>();
  return {
    async copySample(idempotencyKey) {
      const cached = byKey.get(idempotencyKey);
      if (cached !== undefined) return ok(cached);
      let real: string;
      try {
        await mkdir(deps.samplesDir, { recursive: true });
        const dst = await nextSampleDir(deps.samplesDir);
        await copySampleTree(deps.sourceDir, dst);
        real = await realpath(dst);
      } catch {
        return err(errors.artifactWriteFailed({ userMessage: 'Relay could not copy the sample project.' }));
      }
      const copy: SampleCopy = {
        realpath: real,
        createInput: {
          rootRealpath: real,
          rootDisplayPath: toDisplayPath(real, deps.homeDir),
          name: SAMPLE_PROJECT_NAME,
          exclusions: [],
          allowedProviderIds: [...SAMPLE_PROVIDER_IDS],
          monthlyAllowanceMicrousd: SAMPLE_MONTHLY_ALLOWANCE_MICROUSD,
        },
      };
      byKey.set(idempotencyKey, copy);
      return ok(copy);
    },
  };
}
