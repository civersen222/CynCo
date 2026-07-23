# Community Skills Index

This is a community index of shareable CynCo **skills** — capability packs you
can install into any CynCo workspace. For how skills work, see
[`docs/skills.md`](../docs/skills.md).

## Installing a skill

```
/skill install <owner>/<repo>[/<subdir>][@<ref>] --yes
```

CynCo fetches the repo as a GitHub zipball (no `git` binary needed), validates
the `SKILL.md`, reports any risky tools it declares, and — after you confirm —
copies it into `~/.cynco/skills/`.

## Index

Community-contributed skills will be listed here. To add yours, open a pull
request appending a row.

| Skill | Author | Install | Description |
|-------|--------|---------|-------------|
| _(none yet — be the first!)_ | | | |

## Contributing a skill

1. Create the skill in your workspace: `/skill new <name>`, then edit
   `~/.cynco/skills/<name>/SKILL.md` (see [`docs/skills.md`](../docs/skills.md)
   for the frontmatter schema).
2. Test it locally: `/skill list`, then `run_skill("<name>")`.
3. Push the skill folder to a public GitHub repo. A repo can hold one skill at
   its root, or several under subdirectories.
4. Open a PR here adding a row to the Index table above with the install spec
   (`<owner>/<repo>[/<subdir>]`).

### Guidelines

- Keep `description` to a single, honest line — it is what users see before
  installing.
- Declare **only** the tools your skill actually uses. Every tool in `tools:`
  must be a real registry tool, and risky tools (filesystem/shell/network) are
  flagged to users at install time.
- Prefer a focused skill over a kitchen sink. Skills compose.
