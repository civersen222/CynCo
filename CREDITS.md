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
