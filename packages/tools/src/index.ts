// Public API of @relay/tools (05). Application-invoked only; no model output calls these directly (ADR-014).
export type { ArtifactStore, ArtifactStoreOptions, InputFileRef, InputFileSnapshot, PutInput, ScopeDir } from './artifact-store.js';
export { INPUT_FILE_MEDIA_TYPE, ORPHAN_MIN_AGE_MS, createArtifactStore } from './artifact-store.js';
export type { DiffCheckOptions, DiffFile, ImportedDiff } from './diff-intake.js';
export { checkDiffPaths, parseImportedDiff } from './diff-intake.js';
export type { Classification, ClassifyContext, EntryStat, Sniff } from './exclusions.js';
export { classify, classifyByContent, classifyByName, compileUserPatterns, sniffBytes } from './exclusions.js';
export type { ExportArtifactsInput, ExportFailure } from './export.js';
export { assertExportDestination, exportArtifacts, isSafeFileName, writeExportFile } from './export.js';
export type { SuspectedSecret, SuspectedSecretLabel } from './secret-scan.js';
export { SECRET_SCAN_MAX_CHARS, detectSuspectedSecret, unacknowledgedSuspectedSecret } from './secret-scan.js';
export { sha256Hex } from './hash.js';
export type { NormalizeOptions, OpenRootOptions, PathRelation, ProjectRoot, RelPath } from './paths.js';
export {
  isSecretRootPath,
  normalizeRelPath,
  openProjectRoot,
  readConfined,
  relPathBrand,
  relationOf,
  resolveInside,
  resolveWouldBe,
} from './paths.js';
export type { Denial, DenialReason, LiveHash, ReadOptions, SelectedFile } from './read.js';
export { hashFiles, readSelected } from './read.js';
export type { ExcludedEntry, FileEntry, InputCaps, ScanOptions, ScanResult, ScanTotals } from './scan.js';
export { scanProject } from './scan.js';
