# Skills

Skills are shareable, self-contained capability packs for CynCo. A skill is a
directory containing a `SKILL.md` file: YAML frontmatter that declares the
skill's identity and the tools it needs, followed by a prose body of
instructions. When a skill runs, its body is loaded into the conversation and
its declared tools become callable — on demand, without bloating the default
prompt.

> The skill format and loader are ported from the **Hearth** project
> (MIT, Ishant Singh / [@0pen-sourcer](https://github.com/0pen-sourcer)) and
> relicensed under CynCo's AGPL-3.0. See [`CREDITS.md`](../CREDITS.md).

## Anatomy of a skill

```
my-skill/
└── SKILL.md
```

```markdown
---
name: my-skill
description: One-line description of what this skill does
version: 0.1.0
author: your-handle
tools: [Read, Grep, Bash]
---

# my-skill

Prose instructions the model reads when it runs this skill. Describe the
workflow, the steps, and anything the model should keep in mind. Any tool listed
in `tools:` is surfaced automatically when the skill runs.
```

### Frontmatter schema

| Field | Required | Rules |
|-------|----------|-------|
| `name` | yes | Lower-kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`). Must match the folder's intent; used as the `run_skill` argument. |
| `description` | yes | Single-line, non-empty. Shown in the skill index and `list_skills`. |
| `tools` | no (defaults to `[]`) | Array of tool names. **Every name must be a real registry tool** (see the tool list in the README) or the skill is rejected at load. |
| `version` | no | String. |
| `author` | no | String. |

Validation is a hand-written checker (no schema library) so the engine keeps its
zero-runtime-dependency posture. A malformed skill is skipped with a warning; it
never crashes the scan.

## Where skills live

Skills are discovered from two directories, scanned every session:

1. **Builtins** — `engine/skills/builtins/`, bundled with CynCo.
2. **Workspace** — `~/.cynco/skills/`, your personal/installed skills.

A workspace skill **overrides** a builtin of the same name. A name-sorted index
(one line per skill) is placed in the system prompt so the model knows what is
available; the index order is deterministic so it never perturbs the
prompt-cache prefix.

## Running skills

Two core meta-tools are always available to the model:

- **`run_skill(name)`** — loads the skill's full instructions into context and
  surfaces its declared tools for the rest of the session.
- **`list_skills()`** — enumerates every available skill with its description.

Tool surfacing is **append-only**: running a skill adds its tools to the loaded
set (they become callable) but never removes anything. This preserves the
append-only prompt-cache invariant.

## Builtin workflow skills

The seven guided workflows ship as builtin skills:

| Skill | Slash alias | What it does |
|-------|-------------|--------------|
| `tdd` | `/tdd` | Red-green-refactor test-driven development |
| `debug` | `/debug` | Reproduce → hypothesize → isolate → fix → verify |
| `review` | `/review` | Gather → analyze → report |
| `plan` | `/plan` | Create a plan, execute each step, verify |
| `brainstorm` | `/brainstorm` | Understand → explore → propose → refine → spec |
| `critique` | `/critique` | Generate → critique → refine (ICR) |
| `research` | `/research` | Scope → decompose → gather → synthesize → report |

`run_skill("tdd")` and `/tdd` are **aliases** — both drive the same phase-gated
workflow engine. Unlike a flat prose skill, a workflow keeps its state machine:
each phase has its own instruction, its own allowed tools, and a gate that must
be satisfied before advancing. The builtin `SKILL.md` for each workflow is a
catalogue entry; execution is handled by the workflow engine, not the body.

Each workflow skill's `tools:` frontmatter equals the union of its phases'
allowed tools, verified by `engine/__tests__/skills/workflowParity.test.ts`.

## Managing skills — the `/skill` command

| Command | Effect |
|---------|--------|
| `/skill list` | Show discovered skills (builtin + workspace). |
| `/skill new <name>` | Scaffold `~/.cynco/skills/<name>/SKILL.md` from a validating template. |
| `/skill install <owner>/<repo>[/<subdir>][@<ref>] --yes` | Install a skill from a public GitHub repo. |
| `/skill remove <name>` | Delete a workspace skill. |

### Installing from GitHub

`/skill install` fetches the repository as a zipball from GitHub's codeload
endpoint — **no `git` binary required** — extracts it, locates the `SKILL.md`
(honoring an explicit subdir, or auto-detecting a single skill), and validates
the frontmatter. Before copying anything into `~/.cynco/skills/`, it prints a
report of the skill's name, description, and tools, **flagging any risky tools**
(filesystem, shell, or network access: `Bash`, `Git`, `Write`, `Edit`,
`MultiEdit`, `ApplyPatch`, `ReplaceFunction`, `WebFetch`). The copy proceeds only
after you confirm.

## Authoring a skill

1. `/skill new my-skill` — scaffolds a starter folder.
2. Edit `~/.cynco/skills/my-skill/SKILL.md`: write the `description`, list the
   `tools:` you need, and write the instruction body.
3. `/skill list` to confirm it loaded (validation errors are reported here).
4. Ask the model to `run_skill("my-skill")`.

To share it, push the folder to a public GitHub repo; others install it with
`/skill install <owner>/<repo>`. See [`skills/README.md`](../skills/README.md)
for the community index.
