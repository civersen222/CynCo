# Vendored: cybernetics-core

This directory is a **vendored copy** of the TypeScript sources from the upstream
cybernetics library. Do not edit files here directly — all changes must flow through
the upstream repo first and then be re-synced.

## Upstream

| Field            | Value                                             |
|------------------|---------------------------------------------------|
| Upstream repo    | `C:\Users\civer\cybernetics`                      |
| Upstream src dir | `C:\Users\civer\cybernetics\cybernetics-ts\src`   |
| Commit at vendor | `925045b7821de223f26540fbd4f49f69d69cd51a`        |
| Vendor date      | 2026-07-12                                        |

## Sync policy

- **All changes flow upstream-first.** Edit the source in
  `C:\Users\civer\cybernetics\cybernetics-ts\src`, commit there, then re-sync here.
- **Direct edits to this vendored copy are forbidden.** They will be silently
  overwritten on the next sync and will corrupt the theory layer.
- After re-syncing, update the *Commit at vendor* hash in this file to the new
  upstream HEAD.

## Drift check

Run from the repo root:

```bash
bun scripts/sync-cybernetics.ts
```

Exit 0 = IN SYNC. Exit 1 = drift detected; the script prints a per-file diff list.
When drift is detected, either re-vendor from upstream (and bump the hash here) or
push the relevant change upstream — do not patch the vendored copy in place.
