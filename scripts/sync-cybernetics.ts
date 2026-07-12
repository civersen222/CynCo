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

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VENDORED_MD = join(import.meta.dir, "../engine/cybernetics-core/VENDORED.md");
const VENDORED_SRC = join(import.meta.dir, "../engine/cybernetics-core/src");
const UPSTREAM_SRC = "C:/Users/civer/cybernetics/cybernetics-ts/src";

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
