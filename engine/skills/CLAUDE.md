# engine/skills

## Purpose
Discovers, validates, and serves "skills" — folders containing a `SKILL.md` whose leading `---`-fenced YAML block is frontmatter (name, description, tools) and whose body is prose instructions loaded lazily when a skill runs. Skills come from a bundled builtin dir and a per-user workspace dir (`~/.cynco/skills`); this package also lets users scaffold (`/skill new`) and install (`/skill install owner/repo`) new ones. `engine/bridge/conversationLoop.ts` loads skills once per session into the process-wide store (`store.ts`) that the `run_skill`/`list_skills` meta-tools (`engine/tools/impl/skillTools.ts`) and the system-prompt skill index (`prompt.ts`) read from. It must never let a skill name or install subdir resolve to a filesystem path outside the workspace skills dir, and must never install or run a skill whose frontmatter declares an unregistered tool.

## Key files
| File | Role |
|---|---|
| `install.ts` | `/skill install owner/repo[/subdir][@ref]` — fetch a GitHub zipball, validate, confirm, copy into the workspace dir |
| `loader.ts` | Scan builtin + workspace dirs, parse/validate frontmatter, and the shared path-safety helpers every skill-name-to-path caller uses |
| `prompt.ts` | Format the skill index into the one-line-per-skill system-prompt block |
| `scaffold.ts` | `/skill new <name>` — write a starter `SKILL.md` template into the workspace dir |
| `store.ts` | Process-wide singleton holding the skills loaded at session startup |
| `types.ts` | `SkillFrontmatter`/`Skill` types, the kebab-case name pattern, risky-tool set, and frontmatter validation |
| `workflowSkill.ts` | Adapter mapping the 7 built-in workflow skill names to `WorkflowDefinition`s so `run_skill` can drive the `WorkflowEngine` instead of flattening a workflow into prose |

## Important types & functions
- **`SKILL_NAME_RE`** (`types.ts:35`) — the lower-kebab-case pattern every skill-name-to-path conversion must validate against before touching disk.
- **`RISKY_TOOLS`** (`types.ts:42`) — filesystem/shell/network tool names; a skill declaring any of these gets a warning in the install confirmation report.
- **`validateFrontmatter`** (`types.ts:58`) — validates parsed YAML against `SkillFrontmatter`, checking `tools` against a caller-supplied `knownTools` set. Called by both `loader.ts`'s `scanDir` and `install.ts`'s `installSkill`.
- **`assertInside`** (`loader.ts:47`) — resolves `candidate` under `root` and throws if it escapes; the backstop behind `resolveWorkspaceSkillDir` and behind `install.ts`'s subdir resolution.
- **`resolveWorkspaceSkillDir`** (`loader.ts:69`) — turns a validated skill name into its directory under the workspace skills dir; every caller (`/skill new`, `/skill install`, `/skill remove`) that turns a name into a path goes through this.
- **`readSkillBody`** (`loader.ts:101`) — strips the frontmatter fence and returns the prose body; called by `run_skill`'s `execute` to build the text handed to the model.
- **`loadSkills`** (`loader.ts:163`) — scans both dirs and returns `{ skills, index }`, with workspace skills overriding builtins of the same name; called once per session by `conversationLoop.ts`'s `ensureSkillsLoaded`.
- **`formatSkillIndexBlock`** (`prompt.ts:10`) — sorts the skill index by name and renders the system-prompt catalogue block; returns `null` when there are no skills.
- **`scaffoldSkill`** (`scaffold.ts:27`) — creates a new workspace skill folder from a template, refusing to overwrite an existing one.
- **`installSkill`** (`install.ts:194`) — fetches a zipball, validates its `SKILL.md`, calls the injected `confirm` callback with a risk report, and copies the skill into the workspace dir on approval.
- **`getSkillByName`** / **`getSkillIndex`** (`store.ts:19`, `store.ts:23`) — read accessors onto the process-wide `SKILLS` array set by `setLoadedSkills` (`store.ts:11`).
- **`getWorkflowForSkill`** (`workflowSkill.ts:41`) — returns the `WorkflowDefinition` backing a skill name, if any; used by `conversationLoop.ts` to start the workflow engine when `run_skill` targets a workflow-backed skill.
- **`workflowSkillTools`** (`workflowSkill.ts:56`) — the union of every phase's `allowedTools` for a workflow, i.e. the canonical value that workflow skill's `tools:` frontmatter must equal.

## Data flow
1. On the first user message of a session, `conversationLoop.ts`'s `ensureSkillsLoaded` calls `loadSkills` (`loader.ts:163`), which scans the builtin and workspace dirs (`scanDir`), splits each `SKILL.md`'s frontmatter fence, parses it as YAML, and validates it with `validateFrontmatter` (`types.ts:58`).
2. The result is published to the process-wide store via `setLoadedSkills` (`store.ts:11`).
3. `formatSkillIndexBlock` (`prompt.ts:10`) turns `getSkillIndex()` (`store.ts:23`) into the skill-catalogue block appended to the system prompt, sorted by name for prefix stability.
4. When the model calls `run_skill`, `skillTools.ts`'s `execute` looks up the skill via `getSkillByName` (`store.ts:19`) and returns its body via `readSkillBody` (`loader.ts:101`) plus its declared `tools[]`.
5. `conversationLoop.ts` intercepts the same `run_skill` tool-use block: it surfaces the skill's declared tools through the `load_tools` channel, and if `getWorkflowForSkill` (`workflowSkill.ts:41`) resolves a `WorkflowDefinition`, starts the `WorkflowEngine` (only when it is currently idle).
6. Separately, `/skill new` calls `scaffoldSkill` (`scaffold.ts:27`), `/skill install` calls `installSkill` (`install.ts:194`) which fetches + extracts a GitHub zipball, validates it, and copies it in after confirmation, and `/skill remove` (in `main.ts`) resolves its target through `resolveWorkspaceSkillDir` (`loader.ts:69`) before deleting.

## Gotchas
- CRLF line endings in a shipped `SKILL.md` broke YAML parsing of a flow sequence (`tools: [Read, Write]\r` raised "Unexpected scalar at node end") and silently disabled all seven built-in skills at once — `splitFrontmatter` in `loader.ts` normalizes `\r\n?` to `\n` before parsing; pinned by `loader.test.ts`'s "parses frontmatter from a CRLF file" and "every shipped built-in skill loads" tests.
- `/skill remove` used to do `path.join(workspaceSkillsDir(), name)` straight into `rmSync({recursive:true, force:true})` with no validation, so `/skill remove ../../Documents` was an arbitrary recursive delete reachable from the dashboard socket — `resolveWorkspaceSkillDir` (`loader.ts:69`) is now the mandatory choke point; pinned by `removeValidation.test.ts`'s traversal tests.
- `install.ts`'s subdir resolution used a plain `path.join` on a spec split by `/`, so `owner/repo/../../..` was an ordinary path that got `cpSync`'d into `~/.cynco/skills`; `resolveSkillDir` now runs the subdir through `assertInside` (`install.ts:121`); pinned by `install.test.ts`.
- `extractZip` (`install.ts:56`) passes both paths through environment variables into PowerShell rather than interpolating them into a single-quoted literal — a quote in either path used to break out of the literal and hand the remainder to the parser.
- `formatSkillIndexBlock` (`prompt.ts:10`) deliberately sorts by name so store insertion order can never perturb the prompt prefix — required for llama.cpp checkpoint caching across turns; pinned by `prompt.test.ts`'s "is deterministic" and "orders entries by name" tests.
- A workflow skill's `SKILL.md` `tools:` frontmatter must equal `workflowSkillTools(wf)` (`workflowSkill.ts:56`) for its workflow, or the declared tools and the tools the workflow engine actually allows will diverge; pinned by `workflowParity.test.ts`.
- `run_skill` only starts a workflow when `!this.workflowEngine.isActive` (`conversationLoop.ts`), so calling `run_skill` on a workflow name mid-workflow does not clobber the active one.
