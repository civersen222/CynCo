#!/usr/bin/env bun
/**
 * sync-cybernetics.ts
 *
 * Drift-check between the vendored cybernetics-core/src and the upstream
 * cybernetics-ts/src.  Run from repo root:
 *
 *   bun scripts/sync-cybernetics.ts
 *
 * Exit 0 = IN SYNC
 * Exit 1 = drift detected (per-file list printed) or misconfiguration
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VENDORED_MD = join(import.meta.dir, "../engine/cybernetics-core/VENDORED.md");
const VENDORED_SRC = join(import.meta.dir, "../engine/cybernetics-core/src");
const UPSTREAM_SRC = "C:/Users/civer/cybernetics/cybernetics-ts/src";
/** Repo root of the upstream library: the parent of its `cybernetics-ts` package dir. */
const UPSTREAM_REPO = resolve(UPSTREAM_SRC, "..", "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/** Recursively collect all .ts file paths relative to a root dir. */
function collectTs(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTs(full, base));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(relative(base, full).replace(/\\/g, "/"));
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Read recorded upstream hash from VENDORED.md
// ---------------------------------------------------------------------------

let recordedHash = "<unknown>";
if (existsSync(VENDORED_MD)) {
  const md = readFileSync(VENDORED_MD, "utf8");
  const m = md.match(/Commit at vendor\s*\|\s*`([0-9a-f]{40})`/);
  if (m) recordedHash = m[1];
}

console.log(`Recorded upstream commit : ${recordedHash}`);
console.log(`Upstream src             : ${UPSTREAM_SRC}`);
console.log(`Vendored src             : ${VENDORED_SRC}`);
console.log();

// ---------------------------------------------------------------------------
// Guard: upstream must exist
// ---------------------------------------------------------------------------

if (!existsSync(UPSTREAM_SRC)) {
  console.error(`ERROR: upstream src not found at ${UPSTREAM_SRC}`);
  console.error("Is the cybernetics repo present on this machine?");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Guard: VENDORED.md's recorded commit must be upstream HEAD
//
// The per-file hashes below only prove the two trees match right now; they say
// nothing about whether the sha written in VENDORED.md is the commit those
// bytes actually came from.  A stale recorded sha makes the provenance record
// lie, so compare it against the upstream repo's HEAD.
// ---------------------------------------------------------------------------

/** Run a git command in the upstream repo; returns trimmed stdout, or null on failure. */
function gitUpstream(args: string[]): string | null {
  const r = spawnSync("git", ["-C", UPSTREAM_REPO, ...args], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

const upstreamHead = gitUpstream(["rev-parse", "HEAD"]);

if (upstreamHead === null) {
  console.log(
    `WARNING: could not read upstream HEAD via git in ${UPSTREAM_REPO} — ` +
    "recorded-commit check skipped."
  );
} else {
  console.log(`Upstream HEAD            : ${upstreamHead}`);
  if (upstreamHead !== recordedHash) {
    console.log(
      `RECORDED COMMIT MISMATCH: VENDORED.md says ${recordedHash}, upstream HEAD is ${upstreamHead}`
    );
    console.log();
    console.log(
      "To resolve: re-vendor from upstream HEAD and set the 'Commit at vendor'\n" +
      "row in engine/cybernetics-core/VENDORED.md to that sha."
    );
    process.exit(1);
  }

  const dirty = gitUpstream(["status", "--porcelain", "--", "cybernetics-ts/src"]);
  if (dirty) {
    console.log(
      "WARNING: upstream cybernetics-ts/src has uncommitted changes — the sha above\n" +
      "         does not describe the bytes being compared:"
    );
    for (const line of dirty.split(/\r?\n/)) console.log(`         ${line}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Collect file sets
// ---------------------------------------------------------------------------

const upstreamFiles = new Set(collectTs(UPSTREAM_SRC));
const vendoredFiles = new Set(collectTs(VENDORED_SRC));

const allFiles = new Set([...upstreamFiles, ...vendoredFiles]);

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

type DriftEntry = { file: string; reason: string };
const drift: DriftEntry[] = [];

for (const rel of allFiles) {
  const upPath = join(UPSTREAM_SRC, rel);
  const vnPath = join(VENDORED_SRC, rel);

  if (!upstreamFiles.has(rel)) {
    drift.push({ file: rel, reason: "VENDORED ONLY (missing upstream)" });
    continue;
  }
  if (!vendoredFiles.has(rel)) {
    drift.push({ file: rel, reason: "UPSTREAM ONLY (not yet vendored)" });
    continue;
  }

  const upHash = hashFile(upPath);
  const vnHash = hashFile(vnPath);
  if (upHash !== vnHash) {
    drift.push({ file: rel, reason: "CONTENT DIFFERS" });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (drift.length === 0) {
  console.log("IN SYNC — vendored copy matches upstream exactly.");
  process.exit(0);
} else {
  console.log(`DRIFT DETECTED — ${drift.length} file(s) differ:\n`);
  for (const { file, reason } of drift) {
    console.log(`  [${reason}]  ${file}`);
  }
  console.log();
  console.log(
    "To resolve: either re-vendor from upstream (bump the hash in\n" +
    "engine/cybernetics-core/VENDORED.md) or push the change upstream first.\n" +
    "Do NOT patch the vendored copy directly."
  );
  process.exit(1);
}
