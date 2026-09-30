import { z } from 'zod';
import { INPUT_CAPS } from '../defaults.js';
import { credentialRefSchema, REDACTED_LABEL_MAX, vaultFileSchema } from '../domain/credential.js';
import { exclusionsSchema, projectSchema } from '../domain/project.js';
import { previewResultSchema } from '../domain/views.js';
import { idSchema } from '../ids.js';
import { nonNegativeMicrousdSchema } from '../money.js';
import { idempotencyKeySchema } from '../primitives.js';
import { credentialStorageModeSchema, providerIdSchema } from '../status.js';
import { emptyInputSchema, op } from './common.js';
import { exportWhatSchema, diffImportResultSchema } from './artifacts.js';
import { ledgerExportTargetSchema } from './ledger.js';

/** Absolute POSIX path (≤ 4096 chars, no NUL). Main/runner only; never part of a renderer DTO. */
export const absPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => s.startsWith('/'), 'must be absolute')
  .refine((s) => !s.includes('\0'), 'must not contain NUL');

/**
 * Runner operations that **main** calls as the second half of a composite (08 H4). They carry realpaths or credential
 * metadata, so they are never merged into `OPERATIONS`, never in the preload allowlist, and never registered with
 * `ipcMain.handle`; they travel only over the private runner port.
 */
export const INTERNAL_RUNNER_OPS = {
  'providers.recordCredentialRef': op({
    channel: 'relay/v1/providers.recordCredentialRef',
    kind: 'command',
    route: 'runner',
    input: z.object({
      providerId: providerIdSchema,
      storageMode: credentialStorageModeSchema,
      vaultFile: vaultFileSchema.nullable(),
      redactedLabel: z.string().max(REDACTED_LABEL_MAX),
    }),
    output: credentialRefSchema,
    errors: ['VALIDATION_FAILED'],
    idempotent: false, // naturally idempotent: upsert by providerId
  }),
  'providers.deleteCredentialRef': op({
    channel: 'relay/v1/providers.deleteCredentialRef',
    kind: 'command',
    route: 'runner',
    input: z.object({ providerId: providerIdSchema }),
    output: z.object({ deleted: z.boolean() }),
    errors: [],
    idempotent: false,
  }),
  'providers.listCredentialRefs': op({
    channel: 'relay/v1/providers.listCredentialRefs',
    kind: 'query',
    route: 'runner',
    input: emptyInputSchema,
    output: z.array(credentialRefSchema),
    errors: [],
    idempotent: false,
  }),
  'projects.createFromRoot': op({
    channel: 'relay/v1/projects.createFromRoot',
    kind: 'command',
    route: 'runner',
    input: z.object({
      idempotencyKey: idempotencyKeySchema,
      rootRealpath: absPathSchema,
      rootDisplayPath: z.string(),
      name: z.string().min(1).max(80),
      exclusions: exclusionsSchema,
      allowedProviderIds: z.array(providerIdSchema),
      monthlyAllowanceMicrousd: nonNegativeMicrousdSchema.nullable(),
      isDemo: z.boolean(),
    }),
    output: projectSchema,
    errors: ['VALIDATION_FAILED', 'CONFLICT', 'PERMISSION_DENIED'],
    idempotent: true,
  }),
  'projects.previewRoot': op({
    channel: 'relay/v1/projects.previewRoot',
    kind: 'query',
    route: 'runner',
    input: z
      .union([z.object({ rootRealpath: absPathSchema }), z.object({ projectId: idSchema('project') })])
      .and(z.object({ extraExclusions: exclusionsSchema.default([]) })),
    output: previewResultSchema,
    errors: ['NOT_FOUND', 'PERMISSION_DENIED'],
    idempotent: false,
  }),
  'artifacts.importDiffText': op({
    channel: 'relay/v1/artifacts.importDiffText',
    kind: 'command',
    route: 'runner',
    input: z.object({
      projectId: idSchema('project'),
      text: z.string().max(INPUT_CAPS.maxDiffBytes),
      fileName: z.string().max(255),
    }),
    output: diffImportResultSchema,
    errors: ['VALIDATION_FAILED', 'PERMISSION_DENIED'],
    idempotent: false,
  }),
  'artifacts.exportTo': op({
    channel: 'relay/v1/artifacts.exportTo',
    kind: 'command',
    route: 'runner',
    input: z.object({ runId: idSchema('run'), what: exportWhatSchema, destinationRealpath: absPathSchema }),
    output: z.object({ writtenRealpaths: z.array(absPathSchema) }), // main converts to display paths
    errors: ['ARTIFACT_WRITE_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND'],
    idempotent: false,
  }),
  'projects.exportTo': op({
    channel: 'relay/v1/projects.exportTo',
    kind: 'command',
    route: 'runner',
    input: z.object({
      projectId: idSchema('project'),
      runIds: z.array(idSchema('run')).optional(),
      destinationRealpath: absPathSchema,
    }),
    output: z.object({ writtenRealpath: absPathSchema }),
    errors: ['ARTIFACT_WRITE_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND'],
    idempotent: false,
  }),
  'ledger.exportTo': op({
    channel: 'relay/v1/ledger.exportTo',
    kind: 'command',
    route: 'runner',
    input: ledgerExportTargetSchema.and(z.object({ destinationRealpath: absPathSchema })),
    output: z.object({ writtenRealpath: absPathSchema }),
    errors: ['ARTIFACT_WRITE_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND'],
    idempotent: false,
  }),
} as const;

/** Channel of an internal runner operation. */
export type InternalChannel = (typeof INTERNAL_RUNNER_OPS)[keyof typeof INTERNAL_RUNNER_OPS]['channel'];
