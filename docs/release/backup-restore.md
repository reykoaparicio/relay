# Backup and restore (manual, 03 §C7, spec §18.4)

Relay keeps everything in one data folder (userData):

| Path | Contents | In a backup? |
|---|---|---|
| `relay.sqlite` (+ `-wal`, `-shm` while open) | projects, memory, runs, ledger, settings | yes (a consistent snapshot) |
| `artifacts/` | outputs, patches, reports, context manifests, raw responses | yes (the unpurged files the snapshot references) |
| `secrets/` | OS-protected API key files | **never** |
| `logs/`, `exports/` | logs; files you exported | no |
| `backups/` | earlier backups | no |

The data folder is `~/Library/Application Support/Relay` for the packaged app, or whatever `RELAY_USER_DATA_DIR` names in development and demo use. **Settings → Data folder and backup** shows the path.

## Create a backup

**Recommended: in the app.** Go to **Settings → Data folder and backup → Create backup**. This writes `backups/<YYYYMMDD-HHmmss>/` containing:

- `relay.sqlite`, made through SQLite's online backup, so it is consistent even while runs are active;
- `artifacts/…`, every unpurged artifact the snapshot references;
- `manifest.json`, which holds `{ schemaVersion, createdAt, artifactCount, sha256s }`.

The app shows the folder path and size when it finishes. Copy that folder somewhere safe, such as an external disk. Backups never contain `secrets/`.

**By hand, with Relay closed:**

1. Quit Relay (⌘Q). Wait until no `Relay` process remains (`pgrep -l Relay` prints nothing).
2. Copy `relay.sqlite`, plus any `relay.sqlite-wal` and `relay.sqlite-shm`, and `artifacts/` to the backup location. Do not copy `secrets/`.

Make a backup **before installing a new pilot build**. Migrations run automatically on first launch, and earlier versions cannot open a migrated database.

## Restore a backup

The P0 UI has no restore button. Restore by hand:

1. Quit Relay (⌘Q) and confirm no `Relay` process remains.
2. Move the current data aside. Don't delete it:
   ```sh
   cd "$HOME/Library/Application Support"
   mv Relay "Relay.before-restore-$(date +%Y%m%d-%H%M%S)"
   mkdir Relay
   ```
3. Copy in the backup:
   ```sh
   cp "<backup>/relay.sqlite" Relay/relay.sqlite
   cp -R "<backup>/artifacts" Relay/artifacts
   ```
   Do **not** copy a `-wal`/`-shm` from anywhere else. The backup DB is self-contained.
4. Keys: either move `secrets/` back from the folder you set aside (`mv "Relay.before-restore-…/secrets" Relay/secrets`, then `chmod 700 Relay/secrets`), or re-enter the keys in **Settings → Providers** after launch. A key file only works together with the credential record of the database it was saved with. Keys saved after the backup was taken need re-entering.
5. Launch Relay. Check **Settings → Diagnostics**: schema version, runner ready. Then check that **Runs** shows the expected history.
6. Optional: compare the artifacts with the manifest:
   ```sh
   cd Relay/artifacts && find . -type f -exec shasum -a 256 {} + | awk '{print $1}' | sort > /tmp/have.txt
   jq -r '.sha256s[]' "<backup>/manifest.json" | sort > /tmp/want.txt && diff /tmp/want.txt /tmp/have.txt
   ```

A restored database may hold runs that were active when the backup was taken. On launch, crash recovery shows them as **interrupted**, and any request that was in flight as **unknown**. Nothing is re-sent without your decision.

`tests/integration/backup.int.test.ts` covers this procedure.

## Demo profile

The demo profile is not restored from a backup. Use `pnpm demo:reset` (`docs/demo/rehearsal-checklist.md`), which restores `docs/demo/snapshot/` into `Relay-Demo` only.
