"""The first learner in the authority ladder (Phase 5, ruling 5).

Could we have seen the outcome coming? `scripts/cynco-outcome-dataset.mjs`
writes one row per labeled mission from its first K turns — a FIXED count
(K = 16 primary, K = 32 secondary), because a fractional prefix leaks the
finished length; nothing written after the run ends may enter a feature. This
script
trains two classical models on the TRAINING split of those rows and scores
them on the FROZEN HOLDOUT (`benchmark/cynco-ledger/frozen-eval.json`) and on
nothing else:

  lr  = LogisticRegression(max_iter=1000, class_weight='balanced')
  gbt = HistGradientBoostingClassifier(max_depth=3, max_iter=200)

both on standardised features. The positive class is FAILURE: every
probability here is `pFail`, the same direction the S5 rules are tested in
(does it fire more often on missions that failed?).

The models earn nothing by themselves. Their held-out predictions go to
`scripts/cynco-rule-verdicts.mjs` (`modelRowsFrom`), where "fired" means
`pFail >= 0.5` on a held-out mission and the synthetic rules `M1.lr` and
`M1.gbt` face the same Fisher/Wilson/Holm arithmetic every S5 rule does. The
numbers written here (precision, recall, Brier, AUC) are for the reader; the
verdict is computed there, once.

Features
--------
The feature keys are read from the rows (never a hard-coded list), in
first-seen order. A null is unmeasured, not zero (F16): it is imputed with the
TRAINING mean of that feature and nothing else is added. A column that is null
on every training row, or holds one value on every measured training row,
carries no information and is dropped and listed in `droppedFeatures` (with
`droppedReasons`: "all null" | "constant"). On the 2026-09-26 ledger at K = 16
that is the six brain entropy features (no labeled row has brain telemetry
yet), `consecutiveUnstable.*` (always exactly K) and `stuckTurns.*` (always 0).

The leak check
--------------
With `--hindsight <jsonl>` (the same missions' rows built from ALL their
turns) the same two models are refitted on those rows and scored on the same
holdout. If hindsight separates the outcomes and the prefix does not, the
feature vector describes outcomes after the fact — which is itself the
finding. `lengthFeature` names any kept feature that would carry the
mission's length (null when none does — the fixed-K prefix is what makes the
prefix/hindsight comparison meaningful).

`--dataset32` runs the same pipeline on the K = 32 rows and writes it under
`secondary`. Only the primary (K = 16) predictions enter the ladder.

Signals version (F165)
----------------------
A dataset row carries `signalsVersion` (1 when absent: pre-F165 turns, where
`consecutiveUnstable` was the turn index and `algedonicAlerts` cumulative).
`--signals-version N` trains and scores only version-N rows (primary,
hindsight and K = 32 alike); the file then records `signalsVersion: N` and
`secondary.otherSignalsVersions` — per left-out version, its eligible,
failure, success and held-out counts. Without the flag every row is used,
`signalsVersion` is null and `secondary` is unchanged. `rowsByVersion` is
always written — `{"<version>": eligible missions}`, from `--rows-by-version`
(the hindcast passes the counts it made BEFORE filtering its export to one
version) or else the dataset's labeled rows per version — and a refusal under
`--signals-version` ends with ` (signals vN: n eligible; v1: m)`.
`scripts/cynco-hindcast.mjs` always trains on one version (2). The manifest
holds one frozen set per signals version (`{"schema": 2, "sets": {...}}`, fix
round 2); the held-out ids are those of `--signals-version`'s set (version 1
without the flag). A Phase 5 schema-1 file is version 1's set.

Version
-------
`version` is the previous file's version + 1 when any held-out prediction
changed, and unchanged when none did, so the version counts retrains that
said something different.

Exit codes: 0 written; 2 too few rows (or one class) — nothing written, the
reason printed on stdout; 1 bad input. Never touches the network.

Usage:
  python scripts/cynco-outcome-model.py --dataset D.jsonl --manifest frozen-eval.json --out outcome-model.json
      [--hindsight H.jsonl] [--dataset32 D32.jsonl] [--min-train 30] [--min-holdout 8] [--signals-version N] [--rows-by-version JSON]
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler

SCHEMA = 1
THRESHOLD = 0.5
# Predictions are compared (and written) at this many decimals, so a retrain
# that differs only in the last float bits does not count as a new version.
DECIMALS = 6
# Feature keys that would carry the mission's length. None may exist: the
# dataset's prefix is a fixed number of turns (the Task 4 review found a
# fractional prefix leaked the finished length — failures ran a median 169
# turns against 95.5), and `prefixTurns` is metadata, never a feature.
LENGTH_KEYS = ("turnsInPrefix", "prefixTurns", "turns", "totalTurns")


def read_rows(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise SystemExit(f"{path}:{n}: not a JSON line ({e})")
    return rows


def row_version(r):
    """A dataset row's signals version (F165); 1 when it carries none."""
    v = r.get("signalsVersion")
    return v if isinstance(v, int) and not isinstance(v, bool) else 1


def by_version(rows, version):
    """(rows of `version`, the rest). `version` None keeps every row."""
    if version is None:
        return rows, []
    return [r for r in rows if row_version(r) == version], [r for r in rows if row_version(r) != version]


def version_counts(rows, held):
    """Eligible counts of the rows left out by --signals-version, per version."""
    lab = labeled(rows)
    out = {}
    for v in sorted({row_version(r) for r in lab}):
        vs = [r for r in lab if row_version(r) == v]
        out[str(v)] = {
            "eligible": len(vs),
            "failures": sum(1 for r in vs if r["label"] is False),
            "successes": sum(1 for r in vs if r["label"] is True),
            "holdout": sum(1 for r in vs if r.get("missionId") in held),
        }
    return out


def held_ids(manifest, version):
    """The frozen holdout ids for a signals version (F165 fix round 2). A
    schema-2 file holds one set per version under `sets`; a Phase 5 schema-1
    file IS version 1's set. With no version filter, version 1 (the Phase 5
    behaviour). A version with no frozen set holds nothing."""
    v = 1 if version is None else version
    if manifest.get("schema") == 2 and isinstance(manifest.get("sets"), dict):
        s = manifest["sets"].get(str(v)) or {}
        return set(s.get("missionIds") or [])
    if manifest.get("schema") == 1:
        return set(manifest.get("missionIds") or []) if v == 1 else set()
    raise SystemExit(f"--manifest is not a frozen-eval manifest (schema {manifest.get('schema')})")


def parse_rows_by_version(text, rows):
    """`{"<version>": n}` — from --rows-by-version when given, else the
    labeled rows of the dataset counted per version."""
    if text is None:
        out = {}
        for r in labeled(rows):
            k = str(row_version(r))
            out[k] = out.get(k, 0) + 1
        return dict(sorted(out.items()))
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise SystemExit(f"--rows-by-version is not JSON: {e}")
    if not isinstance(parsed, dict) or not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in parsed.values()):
        raise SystemExit(f"--rows-by-version must map a version to a count, got {text}")
    return {str(k): v for k, v in sorted(parsed.items())}


def version_note(version, rows_by_version):
    """` (signals v2: 3 eligible; v1: 104)` — empty without a version filter."""
    if version is None:
        return ""
    others = "; ".join(f"v{k}: {n}" for k, n in rows_by_version.items() if k != str(version))
    return f" (signals v{version}: {rows_by_version.get(str(version), 0)} eligible{'; ' + others if others else ''})"


def labeled(rows):
    """Rows with a boolean label; the dataset writer only emits these, but an
    unlabeled row must never be read as either class."""
    return [r for r in rows if isinstance(r.get("label"), bool)]


def feature_keys(rows):
    keys = []
    seen = set()
    for r in rows:
        for k in (r.get("features") or {}):
            if k not in seen:
                seen.add(k)
                keys.append(k)
    return keys


def matrix(rows, keys):
    x = np.full((len(rows), len(keys)), np.nan, dtype=float)
    for i, r in enumerate(rows):
        feats = r.get("features") or {}
        for j, k in enumerate(keys):
            v = feats.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
                x[i, j] = float(v)
    return x


def y_fail(rows):
    return np.array([0 if r["label"] else 1 for r in rows], dtype=int)


def split(rows, held):
    return [r for r in rows if r.get("missionId") not in held], [r for r in rows if r.get("missionId") in held]


def fnum(v):
    return None if v is None else float(v)


def auc_of(y, p):
    # AUC is undefined on a holdout of one class: unmeasured, not 0.5.
    if len(set(y.tolist())) < 2:
        return None
    return float(roc_auc_score(y, p))


def fit_eval(train, holdout):
    """Fit both models on `train`, score on `holdout`. Returns the kept and
    dropped feature keys and, per model, holdout metrics and predictions."""
    keys = feature_keys(train + holdout)
    xtr, xho = matrix(train, keys), matrix(holdout, keys)
    all_null = np.all(np.isnan(xtr), axis=0) if len(train) else np.ones(len(keys), dtype=bool)
    # A column with one value on every measured training row cannot separate
    # anything (a counter that is always K, a count that is always 0): dropped
    # and named like an all-null one, never fitted on.
    with np.errstate(invalid="ignore"):
        spread = np.array([np.nanmax(c) - np.nanmin(c) if not dead else 0.0 for c, dead in zip(xtr.T, all_null)]) if len(keys) else np.zeros(0)
    constant = ~all_null & (spread == 0)
    dead_cols = all_null | constant
    kept = [k for k, dead in zip(keys, dead_cols) if not dead]
    dropped = [k for k, dead in zip(keys, dead_cols) if dead]
    reasons = {k: ("all null" if n else "constant") for k, n, d in zip(keys, all_null, dead_cols) if d}
    xtr, xho = xtr[:, ~dead_cols], xho[:, ~dead_cols]
    means = np.nanmean(xtr, axis=0)
    for x in (xtr, xho):
        idx = np.where(np.isnan(x))
        x[idx] = np.take(means, idx[1])
    scaler = StandardScaler().fit(xtr)
    xtr, xho = scaler.transform(xtr), scaler.transform(xho)
    ytr, yho = y_fail(train), y_fail(holdout)

    models = {
        "lr": LogisticRegression(max_iter=1000, class_weight="balanced"),
        "gbt": HistGradientBoostingClassifier(max_depth=3, max_iter=200, random_state=0),
    }
    out = {}
    for name, model in models.items():
        model.fit(xtr, ytr)
        fail_col = list(model.classes_).index(1)
        p = model.predict_proba(xho)[:, fail_col]
        fired = p >= THRESHOLD
        tp = int(np.sum(fired & (yho == 1)))
        fp = int(np.sum(fired & (yho == 0)))
        fn = int(np.sum(~fired & (yho == 1)))
        out[name] = {
            # No mission fired → precision is unmeasured; no failure in the
            # holdout → recall is. Never 0 for "could not be computed" (F16).
            "precision": fnum(tp / (tp + fp)) if tp + fp else None,
            "recall": fnum(tp / (tp + fn)) if tp + fn else None,
            "brier": float(np.mean((p - yho) ** 2)) if len(yho) else None,
            "auc": auc_of(yho, p),
            "predictions": sorted(
                ({"missionId": r["missionId"], "pFail": round(float(v), DECIMALS)} for r, v in zip(holdout, p)),
                key=lambda d: d["missionId"],
            ),
        }
    return kept, dropped, reasons, out


def evaluate(rows, held, min_train, min_holdout):
    """One dataset through the split and both models, or `{refusal}`."""
    train, holdout = split(labeled(rows), held)
    if len(train) < min_train or len(holdout) < min_holdout:
        return {"refusal": f"TOO FEW: train {len(train)} < {min_train} or holdout {len(holdout)} < {min_holdout}"}
    classes = set(y_fail(train).tolist())
    if len(classes) < 2:
        return {"refusal": f"ONE CLASS: the {len(train)} training rows are all {'failures' if 1 in classes else 'successes'}, nothing to separate"}
    kept, dropped, reasons, models = fit_eval(train, holdout)
    turns =sorted({r.get("prefixTurns") for r in train + holdout if isinstance(r.get("prefixTurns"), int)})
    return {
        "prefixTurns": turns[0] if len(turns) == 1 else (turns or None),
        "nTrain": len(train),
        "nHoldout": len(holdout),
        # The HOLDOUT failure rate: the base every fired set is compared with.
        "baseRate": float(np.mean(y_fail(holdout))),
        "features": kept,
        "droppedFeatures": dropped,
        "droppedReasons": reasons,
        "models": models,
    }


def previous_version(path, models):
    """The version to write, an int: the previous file's version when no
    held-out prediction changed, else that + 1; 1 when there is no readable
    schema-matching file at `path`."""
    if not os.path.exists(path):
        return 1
    try:
        with open(path, encoding="utf-8") as f:
            prev = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[outcome-model] {path} is not readable JSON; starting over at version 1: {e}", file=sys.stderr)
        return 1
    if not isinstance(prev, dict) or prev.get("schema") != SCHEMA or not isinstance(prev.get("version"), int):
        print(f"[outcome-model] {path} is not a schema-{SCHEMA} outcome model; starting over at version 1", file=sys.stderr)
        return 1
    before = {k: (prev.get("models") or {}).get(k, {}).get("predictions") for k in models}
    after = {k: models[k]["predictions"] for k in models}
    return prev["version"] if before == after else prev["version"] + 1


def write_atomic(path, obj):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def main(argv):
    ap = argparse.ArgumentParser(description="Train the outcome models and score them on the frozen holdout.")
    ap.add_argument("--dataset", required=True, help="prefix-only dataset JSONL at the primary fixed K (K = 16 turns)")
    ap.add_argument("--manifest", required=True, help="frozen-eval.json")
    ap.add_argument("--out", required=True, help="outcome-model.json to write")
    ap.add_argument("--hindsight", help="the same missions built from all their turns, for the leak check")
    ap.add_argument("--dataset32", help="the second, later prefix (K = 32 turns), reported under `secondary`")
    ap.add_argument("--min-train", type=int, default=30)
    ap.add_argument("--min-holdout", type=int, default=8)
    ap.add_argument("--signals-version", type=int, default=None,
                    help="train and score only rows of this signals version (F165; a row without one is v1)")
    ap.add_argument("--rows-by-version", default=None,
                    help='JSON {"<version>": eligible missions} as the caller counted them before filtering '
                         "(the hindcast's export); default: the labeled rows of --dataset per version")
    args = ap.parse_args(argv)
    if args.signals_version is not None and args.signals_version < 1:
        raise SystemExit(f"--signals-version must be a positive integer, got {args.signals_version}")

    with open(args.manifest, encoding="utf-8") as f:
        manifest = json.load(f)
    held = held_ids(manifest, args.signals_version)

    all_rows = read_rows(args.dataset)
    rows_by_version = parse_rows_by_version(args.rows_by_version, all_rows)
    rows, other_rows = by_version(all_rows, args.signals_version)
    primary = evaluate(rows, held, args.min_train, args.min_holdout)
    if "refusal" in primary:
        # F165: a refusal under a version filter names what each version had,
        # so "TOO FEW" reads as "too few v2 missions yet", never as a mixed set.
        print(primary["refusal"] + version_note(args.signals_version, rows_by_version))
        return 2
    models = primary["models"]

    leak = None
    if args.hindsight:
        htrain, hholdout = split(labeled(by_version(read_rows(args.hindsight), args.signals_version)[0]), held)
        if len(set(y_fail(htrain).tolist())) < 2 or not hholdout:
            leak = {k: {"aucPrefix": models[k]["auc"], "aucHindsight": None} for k in models}
        else:
            _, _, _, hmodels = fit_eval(htrain, hholdout)
            leak = {k: {"aucPrefix": models[k]["auc"], "aucHindsight": hmodels[k]["auc"]} for k in models}

    # The second, later prefix (K = 32 turns): reported, never laddered. Its
    # refusal is recorded in place of its numbers rather than failing the run.
    secondary = None
    if args.dataset32:
        s = evaluate(by_version(read_rows(args.dataset32), args.signals_version)[0], held, args.min_train, args.min_holdout)
        secondary = {"refusal": s["refusal"]} if "refusal" in s else s
    # F165: with --signals-version, the rows of the OTHER version(s) are not
    # silently gone — their eligible counts are reported here. Only then:
    # a run without the flag writes `secondary` exactly as before.
    if args.signals_version is not None:
        secondary = {**(secondary or {}), "otherSignalsVersions": version_counts(other_rows, held)}

    out = {
        "schema": SCHEMA,
        "version": previous_version(args.out, models),
        "trainedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        # null: every row, whatever its version (the pre-F165 behaviour).
        "signalsVersion": args.signals_version,
        # F165: eligible missions per signals version, as counted before any
        # version filter — how much of the ledger this model could not use.
        "rowsByVersion": rows_by_version,
        **primary,
        # The feature that would leak the finished length. The dataset's
        # prefix is a fixed K turns, so no length can be read from it; this is
        # the check, not a constant — a length-named key among the kept
        # features is named here.
        "lengthFeature": next((k for k in primary["features"] if k in LENGTH_KEYS), None),
        "leakCheck": leak,
        "secondary": secondary,
    }
    write_atomic(args.out, out)
    summary = ", ".join(
        f"{k} precision {models[k]['precision'] if models[k]['precision'] is None else round(models[k]['precision'], 3)}"
        f" auc {models[k]['auc'] if models[k]['auc'] is None else round(models[k]['auc'], 3)}"
        for k in models
    )
    print(f"outcome model v{out['version']}: train {out['nTrain']}, holdout {out['nHoldout']} (base {out['baseRate']:.3f}); {summary} -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
