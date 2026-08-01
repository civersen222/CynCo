/**
 * `/skill remove` must delete the path the validator returned — not a path it
 * built itself.
 *
 * Audit finding 2 was the most severe of the twelve: `/skill remove <name>` did
 *
 *   const dir = path.join(workspaceSkillsDir(), name)
 *   fs.rmSync(dir, { recursive: true, force: true })
 *
 * on a raw argv token reachable from the dashboard socket. `path.join` resolves
 * `..`, so `/skill remove ../../Documents` was an arbitrary recursive delete.
 *
 * The repair added `resolveWorkspaceSkillDir`, and
 * engine/__tests__/skills/removeValidation.test.ts pins that function hard — a
 * traversal table, the containment property, and "a rejected name deletes
 * nothing". None of that observes main.ts. Reverting engine/main.ts:748 to the
 * `path.join` form reopened the delete and every one of those 27 tests still
 * passed, because a validator nobody calls validates nothing. Five lesser
 * findings (3, 7, 8, 9, 12) each shipped a call-site guard; the severe one did
 * not. This is that guard.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

/** Full-line comments only. The reverted shape is quoted verbatim in a comment
 *  at main.ts:743, so a check that reads comments as code can never fail. */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

const source = stripLineComments(readFileSync('engine/main.ts', 'utf-8'))

/** The body of the `/skill remove` branch, from its discriminant to the delete. */
function removeBranch(): string {
  const start = source.indexOf("sub === 'remove'")
  expect(start, "the `/skill remove` branch is not in main.ts under the shape this guard reads")
    .toBeGreaterThan(-1)
  const end = source.indexOf('rmSync(', start)
  expect(end, 'the `/skill remove` branch no longer reaches an rmSync').toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('/skill remove call site', () => {
  it('has a branch this guard can actually read', () => {
    // Guard the guard. If a refactor renames the discriminant or moves the
    // delete, the slice below goes empty or swallows the whole file, and every
    // `toContain` after it passes or fails for reasons that have nothing to do
    // with the finding. Bound it, and fail loudly instead.
    const branch = removeBranch()
    expect(branch.length).toBeGreaterThan(40)
    expect(branch.length).toBeLessThan(1200)
  })

  it('resolves the directory through the validator', () => {
    expect(removeBranch()).toContain('resolveWorkspaceSkillDir(')
  })

  it('deletes the value the validator returned, not one it built itself', () => {
    // `resolveWorkspaceSkillDir` being called somewhere in the branch is not
    // the property. The property is that its return value is the argument to
    // rmSync — a call whose result is dropped on the floor is decoration.
    const branch = removeBranch()
    const assigned = branch.match(/(?:const|let)\s+(\w+)\s*=\s*resolveWorkspaceSkillDir\(/)
    expect(assigned, 'nothing in the branch is assigned from resolveWorkspaceSkillDir').not.toBeNull()
    const varName = assigned![1]
    expect(source.slice(source.indexOf("sub === 'remove'")))
      .toMatch(new RegExp(`rmSync\\(\\s*${varName}\\s*,`))
  })

  it('never rebuilds a skill path with path.join in main.ts', () => {
    // The exact reverted shape, named so this test cannot pass by accident on
    // some other line that happens to mention the validator.
    expect(source).not.toContain('path.join(workspaceSkillsDir()')
    expect(source).not.toContain('join(workspaceSkillsDir()')
  })

  it('imports the validator on the live path', () => {
    expect(source).toContain('resolveWorkspaceSkillDir')
    expect(source).toContain("import('./skills/loader.js')")
  })
})
