# Credits

CynCo builds on ideas and code from other open-source projects. This file
records third-party work incorporated into the codebase and its licensing.

## Skills system

The Skills system (`engine/skills/`) — shareable capability packs defined by a
`SKILL.md` with YAML frontmatter and prose instructions, discovered from builtin
and workspace directories and loaded on demand via `run_skill` — is ported from
the **Hearth** project.

- **Original project:** Hearth
- **Author:** Ishant Singh ([@0pen-sourcer](https://github.com/0pen-sourcer))
- **Original license:** MIT
- **Use here:** The design and portions of the implementation were adapted into
  CynCo and are distributed under CynCo's license, the GNU Affero General Public
  License v3.0 (AGPL-3.0). The MIT license permits this relicensing; the original
  MIT copyright and permission notice are retained below as required.

```
MIT License

Copyright (c) Ishant Singh (@0pen-sourcer), Hearth

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Generative UI (format, vocabulary and prompt rules)

The dashboard's generative UI (`engine/genui/`, the `RenderUI` tool and the
renderer in `engine/dashboard/index.html`) adopts ideas — not code — from three
open-source generative-UI projects. None of their renderers could be used
(React, Vue, Svelte, Angular or Lit, with no React-free no-build bundle), so
the renderer here is hand-written; what was borrowed is the shape of the
problem and the lessons their prompts encode.

- **json-render** (Vercel Labs, Apache-2.0, https://github.com/vercel-labs/json-render):
  the flat element map `{ root, elements: { id: { type, props, children } } }`,
  the shadcn and harness-chat component vocabularies (Steps, FileChange,
  Terminal, TestResults, Metric, label/value charts), the `*_in_props`
  relocation fixes, and the prompt rules about numbers-as-strings and
  omitted children.
- **A2UI** (a2ui-project, Apache-2.0, https://github.com/a2ui-project/a2ui):
  surfaces that an agent can update in place, actions carrying a name plus
  context and the surface's live input values, "root first, parents before
  children" so a surface draws while it streams, and the evidence that plain
  JSON is the most accurate format a model emits.
- **OpenUI** (Thesys, MIT, https://github.com/thesysdev/openui) and its
  **open-intelligent-ui** demo: the chat component vocabulary (FollowUps,
  Callout, Tags, KeyValue, Steps, card groups), the rule that an unreferenced
  element must be reported rather than silently dropped, the streaming word
  fade, buttons disabled while streaming, the safe-URL filter and the
  "form values go back to the assistant as a note" pattern.

No source from these projects is included; CynCo's implementation is
distributed under the GNU Affero General Public License v3.0 (AGPL-3.0).
