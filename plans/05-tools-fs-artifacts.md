# Plan 05: Tools — Root-Confined FS, Exclusions, Diff Intake, Artifact Store (Agent E)

Spec: §3.4, §11.1, §11.2, §11.4, §12.3, FR-01, FR-10 · Backlog: RLY-006 (preview half), RLY-014 (storage half), RLY-023 (export half) · Waves (00 §3): **Wave 1 / M1** E1–E4, E6 · **Wave 2 / M2** E5, E7

Files (exclusive): `packages/tools/src/**`

Everything here is **application-invoked**. No model output calls these functions directly (ADR-014). Every function returns `Result<…, AppError>` for expected failures (`PERMISSION_DENIED`, `NOT_FOUND`, `ARTIFACT_WRITE_FAILED`).

---

## E1: Path confinement (`src/paths.ts`) — the security core

§11.2: "Canonicalize paths and verify containment… string-prefix checks are insufficient."

```ts
import { relPathSchema } from '@relay/contracts';   // 02 primitives: POSIX, no '..' segment, no leading '/', no NUL, ≤ 512 chars

export const relPathBrand = relPathSchema.brand<'RelPath'>();
export type RelPath = z.infer<typeof relPathBrand>;   // the ONLY way to mint a RelPath is normalizeRelPath (or relPathBrand.parse)

export interface ProjectRoot { readonly realpath: string; readonly caseInsensitive: boolean }
export function openProjectRoot(absPath: string, opts: { userDataDir: string }): Promise<Result<ProjectRoot>>;
//  - fs.promises.realpath (native) the chosen dir; must be a directory
//  - refused (PERMISSION_DENIED reason 'unsafe_root'): '/', the home dir itself, the userData dir, any ancestor of
//    userData (a root that CONTAINS userData), and the system dirs /System, /Library, /usr, /bin, /etc (08 pickDirectory
//    applies the same list main-side; this is the runner-side re-check)
//  - subdirectories of os.tmpdir() are VALID roots (compare against realpath(os.tmpdir()), e.g. /private/var/folders/…);
//    E2E and integration tests create projects there
//  - detect case-insensitivity: stat(root) vs stat(root with toggled-case last segment) → same ino ⇒ insensitive (APFS default)

export function normalizeRelPath(input: string): Result<RelPath>;
//  1. rejects: empty, absolute (posix or win32 drive/UNC), NUL byte, backslash-only tricks, segments '.git' when not
//     explicitly allowed; converts '\' → '/'; strips leading './'; applies path.posix.normalize
//  2. the normalized string must then pass relPathBrand.safeParse (so the '..' / length / NUL rules are the contracts
//     rules, not a second copy); failure → VALIDATION_FAILED with the Zod issue

export async function resolveInside(root: ProjectRoot, rel: RelPath): Promise<Result<{ abs: string; real: string }>>;
//  1. abs = path.join(root.realpath, rel)
//  2. real = await fs.promises.realpath(abs)                 // resolves ALL symlinks (symlink escape defense)
//  3. relFromRoot = path.relative(root.realpath, real)
//  4. contained = relFromRoot !== '' && !relFromRoot.startsWith('..' + path.sep) && relFromRoot !== '..' && !path.isAbsolute(relFromRoot)
//     (case-insensitive roots compare lowercased forms)
//  5. !contained → PERMISSION_DENIED { reason: 'outside_root' }   (message never includes the absolute path)
```

`pickDirectory` validation (the native dialog and its selection token) is main-side and lives in 08. `openProjectRoot` re-checks the same rules in the runner, because the runner never trusts main-side validation alone.

`readConfined(root, rel, maxBytes)` opens the **resolved** real path with `fs.open(real, O_RDONLY | O_NOFOLLOW)`, then checks `fstat` to confirm a regular file and that `size ≤ maxBytes`, and reads from that same file handle. Using one handle for the check and the read closes most of the time-of-check/time-of-use (TOCTOU) window.

The remaining risks are documented in `docs/architecture/boundaries.md`, which agent A owns and E supplies text for:
- Hard links cannot be detected.
- A parent directory can be swapped between the realpath call and the open call.
- **This is not an operating-system sandbox** (§6.5).

## E2: Exclusions (`src/exclusions.ts`)

Default exclusion set (§3.4, §11.1). Every exclusion carries a **reason**, and the UI shows it in the file preview (mock `onboarding.html#state=select-project`):

| Reason code | Patterns / rule |
|---|---|
| `dependency_dir` | `node_modules/`, `vendor/`, `.pnpm-store/`, `bower_components/`, `.venv/`, `venv/`, `__pycache__/`, `target/` |
| `build_output` | `dist/`, `build/`, `out/`, `.next/`, `.nuxt/`, `coverage/`, `.turbo/`, `*.min.js`, `*.map`, `*.bundle.js` |
| `vcs_internal` | `.git/`, `.hg/`, `.svn/` |
| `secret` | `.env`, `.env.*` / `.env-*` / `.env_*` (except `.env.example`), `*.env`, `.envrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.tfvars`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.git-credentials`, `.dev.vars`, `.yarnrc.yml`, `credentials*`, `*secret*` (case-insensitive), `service-account*.json`; directories: the same credential-dir runs `paths.ts` refuses as roots (`.aws/`, `.ssh/`, `.gnupg/`, `keychains/`, `.config/gcloud/`, `.kube/`, `.docker/`) — one shared list (`SECRET_ROOT_SEGMENTS`) |
| `os_file` | `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*` |
| `binary` | first 8 KiB contains a NUL byte **or** has >30% non-text bytes; also extensions `png jpg jpeg gif webp ico pdf zip gz tar 7z jar exe dll so dylib wasm mp4 mov woff woff2 ttf otf sqlite db` |
| `too_large` | `size > INPUT_CAPS.maxFileBytes` (64 KiB) |
| `gitignored` | matched by the project's `.gitignore` files (via the `ignore` package, read confined) — default on, toggle in project settings |
| `user_pattern` | project `exclusions` globs (picomatch, `dot: true`) |
| `symlink_outside` | symlink whose target resolves outside root (E1) |
| `cap_exceeded` | would push totals over `maxTotalBytes` / `maxFiles` (listed, not silently dropped) |

`classify(relPath, stat, sniff) → { included: true } | { included: false; reason }` is **pure**: it takes pre-read stat and sniff data so it can be property-tested. The order of checks is fixed: secret → vcs → dependency → build → os → user → gitignored → binary → size → cap. The first match wins, so a `.env` file inside `node_modules` reports `secret`.

**Secrets are never readable, even when the user explicitly selects them.** The reason is shown, and the user must rename or move the file. This implements §11.1's "Read credentials or environment files: denied by default". P0 has no override.

## E3: Scan & preview (`src/scan.ts`)
`scanProject(root, { exclusions, respectGitignore, caps, signal }) → Promise<Result<ScanResult>>`
- Iterative breadth-first walk using `fs.promises.opendir`. It does **not follow directory symlinks**; symlinked files are resolved and checked by E1.
- Excluded directories are never descended into, which keeps `node_modules` fast.
- Output: `{ included: FileEntry[] (relPath, size, sha256?), excluded: {relPath, reason}[] (dirs collapsed to 1 row), totals }`, sorted by relPath.
- Hashes are computed lazily (`hashFiles(root, relPaths)`) only for the files a run selects, not during preview.
- Performance target (§3.3, "within one second" on the fixture): < 300 ms for `tests/fixtures/sample-api`. Tested with a 5,000-file synthetic tree: < 2 s, with `node_modules` pruned.

## E4: Read selected (`src/read.ts`)
`readSelected(root, relPaths, caps) → Promise<Result<{ files: { relPath, content: string, bytes: Uint8Array, sha256, size }[] }>>`
- Every path goes through `normalizeRelPath → resolveInside → classify → readConfined`. Any denial aborts the **whole** read with `PERMISSION_DENIED`, listing the offending relPaths and reasons. There are no partial silent reads (§10.2, "do not silently truncate").
- Content is decoded as UTF-8 with `fatal: true`. Invalid UTF-8 is treated as `binary`.
- `sha256` comes from the exact bytes read. These hashes become `run_input_files` rows and feed the context hash (07).
- `readSelected` also returns the raw `bytes` per file (not only the decoded string), so intake can snapshot exactly what was hashed (E6 `snapshotInputFiles`).

`hashFiles(root, relPaths)` supports stale detection before approval and before implement (06 §F6 `PROJECT_CHANGED`). **The live disk is used only for this stale comparison.** Every consumer of file *content* after intake (07 G1 context assembly, 06 F8 patch validation) reads the intake snapshot via `readSnapshot`, never the live file.

## E5: Diff intake (`src/diff-intake.ts`) — ADR-015
- `parseImportedDiff(text: string) → Result<{ files: { oldPath, newPath, hunks }[], warnings: string[] }>` uses `diff.parsePatch`.
- Input is capped at `INPUT_CAPS.maxDiffBytes` (1 MiB).
- Every `newPath`/`oldPath` must pass `normalizeRelPath`. `/dev/null` is allowed for adds and deletes. Paths are then checked against the project root with `resolveInside` for existing files.
- Referenced files that are excluded (`secret`, and so on) are rejected with `PERMISSION_DENIED`.
- The diff text is stored as an `input_diff` artifact (E6). The **referenced current files** are added to the context by the engine, read through E4, and snapshotted like any other input file (E6 `snapshotInputFiles`).

## E6: Artifact store (`src/artifact-store.ts`) — §12.3, §7.5
```ts
export interface ArtifactStore {
  put(input: { scopeDir: `artifacts/${string}`; artifactId: ArtifactId; bytes: Uint8Array; mediaType: string })
    : Promise<Result<{ relPath: string; sha256: string; sizeBytes: number }>>;
  read(relPath: string, maxBytes: number): Promise<Result<Uint8Array>>;   // purged → NOT_FOUND { purged: true, purgedAt }
  exists(relPath: string): Promise<boolean>;
  purge(relPath: string): Promise<Result<{ purgedAt: number }>>;         // chmod 0o644 → unlink → tombstone (below)

  // §11.2 intake snapshot (kind 'input_file'): the bytes the run was built on
  snapshotInputFiles(runId: RunId, files: readonly { relPath: RelPath; bytes: Uint8Array; sha256: string }[],
                     newId: () => ArtifactId)
    : Promise<Result<InputFileSnapshot[]>>;
  readSnapshot(ref: InputFileRef): Promise<Result<{ content: string; sha256: string }>>;
  sweepOrphans(knownRelPaths: ReadonlySet<string>): Promise<{ removed: number }>;
}
export interface InputFileRef { artifactId: ArtifactId; storeRelPath: string; sha256: string }   // = artifacts row (id, rel_path, sha256)
export interface InputFileSnapshot extends InputFileRef { relPath: RelPath; sizeBytes: number; mediaType: 'text/plain; charset=utf-8' }
export function createArtifactStore(opts: { userDataDir: string; clock: Clock }): ArtifactStore;
```
- Write protocol (crash-safe; **link-based**, as implemented — a `rename` would silently replace an existing final file):
  1. If a tombstone `<final>.purged` exists, fail (`purged`): a purged artifact is never re-created.
  2. Write `<final>.tmp-<rand>` with `O_CREAT|O_EXCL`, `fsync(fd)`, then `chmod 0o444` on the temp file.
  3. `link(tmp, final)`. `link` never replaces: on `EEXIST` the existing file's sha256 is compared — the same bytes are the idempotent case (§7.5), different bytes → `ARTIFACT_WRITE_FAILED` (an invariant breach, logged). So two concurrent puts with different bytes cannot both win.
  4. Unlink the temp name (without chmod: it shares the committed `0o444` inode), then `fsync(dir)`.
  5. Re-check the tombstone: if a purge published one meanwhile, unlink the file and fail `purged` (see Purge for why this closes the race).
- If the final path already exists with the same sha256, return the existing file (idempotent, §7.5). If it exists with a **different** hash, return `ARTIFACT_WRITE_FAILED` (an invariant breach, logged).
- The store may only write under `userDataDir/artifacts/`. `scopeDir` is validated by a regex, `^artifacts/(run|prj)_[0-9A-HJKMNP-TV-Z]{26}$`.
- The DB row is inserted by the engine **after** `put` succeeds, in the step-commit transaction (§7.4 step 7). If the process dies after the file is written but before the row is committed, the file is an orphan. `sweepOrphans(knownRelPaths)` runs at runner boot and deletes files older than 1 h with no row. It never deletes `*.purged` tombstones.

**Purge (§10.4, §12.3 retention; called by 03 C8).** `purge(relPath)` — **tombstone first, then unlink**:
1. Validates `relPath` is under `artifacts/` (same regex on its directory).
2. Publishes the tombstone `<relPath>.purged` (content `{"purgedAt":<ms>}`) the same crash-safe way as a put: temp file (`O_EXCL`, fsync, `0o444`) → `link` to the tombstone name → `fsync(dir)`. If a valid tombstone already exists, its `purgedAt` is kept and returned, so `purge` is idempotent; an empty/garbled one (a crash mid-write in an older build) is repaired by an atomic replace.
3. **Then** `chmod 0o644` (store files are `0o444`) and `unlink` the file. A missing file is not an error.
4. Returns `{ purgedAt }`. Storage then sets `artifacts.purged_at` (03 C8). A crash between any two steps is safe: the tombstone already marks the artifact purged for every reader, and the next sweep repeats the idempotent purge and sets the column.

Because `purge` publishes the tombstone before unlinking and `put` links before re-checking the tombstone, a concurrent put/purge pair always ends purged: either `put`'s re-check sees the tombstone (and removes its file), or the tombstone was written after the link and `purge`'s unlink removes the file.

`read`/`readSnapshot` of a path whose file is gone but whose tombstone exists returns `NOT_FOUND` with `details = { purged: true, purgedAt }`. Without a tombstone a missing file is a plain `NOT_FOUND`. `read` never throws: any other fs failure (EACCES, EIO, EISDIR, …) is `NOT_FOUND` with `details.errno` (the code only, never a path). Tombstones live in `artifact-tombstones.ts` (content validated by the contracts `artifactTombstoneSchema`); temp writes and unlinks in `artifact-fs.ts`.

**fs error causes (2026-10-01).** No fs error collapses silently into `NOT_FOUND`: `details.errno` carries the code (contracts `errnoOf`/`errnoDetails`). `openProjectRoot` maps EACCES/EPERM to `PERMISSION_DENIED unsafe_root`, the same answer `scanProject` gives for an unreadable root. **Scan prefix checks:** `scanProject` sets `ClassifyContext.ancestorsVetted` (it never descends into an excluded directory, so only the entry itself needs the user-pattern/gitignore check); `readSelected` never sets it and checks every prefix of a requested path. `.gitignore` files are loaded only for directories that contain one, into an incremental matcher that consults only a path's ancestor directories.

**Input file snapshots (§11.2, R4-6).** At intake the engine reads the selected files once (E4) and calls `snapshotInputFiles(runId, files, newId)`:
- Files are grouped by `sha256`: identical content in one run is stored **once** (content-addressed within the run). Each unique sha gets one `put` to `artifacts/<runId>/<artifactId>` with media type `text/plain; charset=utf-8`, and every relPath with that sha gets the same `InputFileRef`.
- The caller inserts one `artifacts` row per unique sha (kind `input_file`, `attempt_id` NULL; unique on `(run_id, sha256)` in 03) and one `run_input_files` row per relPath pointing at it, in the intake tx. On a retry of intake, the caller first looks up `ArtifactRepo.findInputFile(runId, sha)` and reuses the existing ref.
- `readSnapshot(ref)` reads `ref.storeRelPath`, verifies the sha256 of the bytes equals `ref.sha256` (a mismatch → `INTERNAL` invariant breach, logged), and decodes UTF-8 with `fatal: true`. The ref is the artifact row, so callers pass what they loaded from `run_input_files` + `artifacts`.
- 07 G1 (context assembly) and 06 F8 (patch application check) read content **only** through `readSnapshot`. The live disk is consulted only by `hashFiles` for the stale check.

`snapshots/<run-id>/manifest.json` (§12.3) is written through the same store under `artifacts/<runId>/` as kind `context_manifest`, and the spec path is kept as a documented alias. **Plan decision:** there is one immutable store rather than two directories, which keeps the protocol single. This is recorded in the ADR-017 notes.

## E7: Export (`src/export.ts`) — FR-10
```ts
exportArtifacts(input: { files: { relPath: string; suggestedName: string }[]; destinationRealpath: string; projectRoots: string[] })
  : Promise<Result<{ written: string[] }>>;                  // artifacts.exportTo (run report / patch)
writeExportFile(destinationRealpath: string, name: string, bytes: Uint8Array, projectRoots: string[])
  : Promise<Result<{ fileName: string }>>;                   // projects.exportTo (JSON bundle), ledger.exportTo (CSV)
```
- `destinationRealpath` comes **only** from main's native save/directory dialog, never from the renderer (02 `INTERNAL_RUNNER_OPS` `*.exportTo`). The runner re-resolves it with `fs.promises.realpath` before the checks.
- **Destination check (shared by both functions, `assertExportDestination`):** refuses with `PERMISSION_DENIED` when, after realpath and case folding for case-insensitive volumes:
  - the destination is **inside** (or equal to) any registered project root → reason `inside_project`, or
  - the destination **contains** any registered project root (a project root is inside it, for example exporting to `~/code` when `~/code/sample-api` is a project) → reason `contains_project`.

  Containment uses the E1 `path.relative` test, never a string prefix. This is FR-10: exports never write into project source trees.
- `name` (for `writeExportFile`) must be a single safe file name (no separator, no NUL, not `.`/`..`, ≤ 255 bytes); otherwise `VALIDATION_FAILED`.
- Both write with `O_CREAT|O_EXCL`. On a name clash they append ` (2)`, ` (3)`, …, and never overwrite. The returned names are file names only (no absolute path).
- On failure they return `ARTIFACT_WRITE_FAILED`. The run is untouched, and a retry re-runs only the export (§17.1 "retry only export").

## Unit tests (owned by E, colocated; real temp dirs via `fs.mkdtemp` under `os.tmpdir()`)

| File | Must cover |
|---|---|
| `paths.test.ts` | Rejects `../x`, `a/../../x`, `/etc/passwd`, `C:\\x`, `\\\\server\\share`, `a\\0b`, a 513-char path. Accepts `src/./a.ts` → `src/a.ts`. A string accepted by `normalizeRelPath` always passes contracts `relPathSchema` (fast-check). **Symlink escape**: `root/link → /tmp/outside/secret.txt` → `PERMISSION_DENIED outside_root`. Symlink inside the root → allowed. A root that is itself a symlink resolves correctly. Case-insensitive root: `SRC/A.ts` resolves inside. `openProjectRoot`: an `os.tmpdir()` subdirectory is accepted; `/`, the home dir, the userData dir, and an ancestor of userData are refused. `fast-check`: for random segment arrays including `..`, `resolveInside` never returns a path outside the root |
| `exclusions.test.ts` | One row per reason code. Order precedence (`node_modules/.env` → `secret`). `.env.example` included. Binary sniff for NUL. `*secret*` case-insensitive |
| `scan.test.ts` | Fixture-like tree: counts and totals exact. `node_modules` never opened (spy on `opendir`). Directory symlink not followed. `cap_exceeded` rows listed |
| `read.test.ts` | One denied file fails the whole read. Invalid UTF-8 → binary. sha256 matches `crypto` of the returned `bytes` |
| `diff-intake.test.ts` | Valid multi-file diff parses. A path with `..` is rejected. A diff touching `.env` is rejected. Oversize is rejected |
| `artifact-store.test.ts` | Put is idempotent for the same bytes. A different hash at the same path fails. The file is read-only after put. A crash simulation (throw between write and rename) leaves only a `.tmp` that `sweepOrphans` removes. **Purge:** removes a `0o444` file, writes a tombstone, and returns `purgedAt`; a second `purge` returns the same `purgedAt`; `read` afterwards → `NOT_FOUND` with `details.purged === true`; `sweepOrphans` keeps the tombstone |
| `input-snapshot.test.ts` | `snapshotInputFiles` with two relPaths of identical content performs one `put` and returns the same ref for both. `readSnapshot` returns the snapshot content after the live file is **modified or deleted** on disk. A tampered snapshot file (sha mismatch) → `INTERNAL`. A purged snapshot → `NOT_FOUND` `purged` |
| `export.test.ts` | Destination inside the project root is refused (`inside_project`), including via a symlinked destination. A destination that **contains** a project root is refused (`contains_project`). A sibling directory is allowed. No overwrite (name suffixing) for both `exportArtifacts` and `writeExportFile`. `writeExportFile` rejects a name with `/` or `..` |

## Success Criteria (gate)
- [ ] `pnpm typecheck && pnpm test:unit packages/tools --coverage --coverage.include='packages/tools/src/**'` → green, ≥ 90% lines
- [ ] `pnpm lint` → exit 0
- [ ] `pnpm test:unit packages/tools -t "symlink escape"` → passes (named test exists)
- [ ] `pnpm test:unit packages/tools -t "contains_project"` → passes (named test exists)
- [ ] Scan benchmark test (`scan.bench.test.ts`, tagged `@perf`) → fixture < 300 ms on the dev Mac

## Review Checklist
- [ ] No string-prefix containment check anywhere (grep `startsWith(root`)
- [ ] `RelPath` is derived from contracts `relPathSchema` (no second definition of the path rules)
- [ ] Absolute paths never appear in `AppError.userMessage` or `details`
- [ ] Every write path is under `userData/artifacts` or a dialog-chosen export dir that is neither inside nor containing a project root
- [ ] Secret-class files are unreadable through every entry point (scan, read, diff intake, snapshot)
- [ ] After intake, no content read goes to the live project disk; only `hashFiles` touches it (stale check)
- [ ] Apart from the `put` write protocol and `sweepOrphans` (row-less files only), `purge` is the only code that chmods or unlinks a stored artifact
