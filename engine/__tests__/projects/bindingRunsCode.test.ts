import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gradeProjectCall, RUNS_CODE_REASON, COMFY_FENCE_REASON } from '../../projects/binding.js'
import { classifyRisk, describeRisk } from '../../bridge/guardianRules.js'

/**
 * GLM review S2: in a project chat the grader, not the user, decided whether
 * Bash ran. `Write evil.py` inside the folder graded safe and `python evil.py`
 * matched no risky pattern, so code the model had just written executed with no
 * card — the folder fence contains writes, not execution. The owner is present
 * in a project chat by definition, so running a program or script in the
 * project now asks. Inline one-liners the user can read whole in the tool row
 * (`python -c "print(400*1.1)"`) stay graded as before, unless they reach for
 * the modules that leave the folder: the shell, the network, the filesystem.
 */
const root = mkdtempSync(join(tmpdir(), 'cynco-runs-code-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
const grade = (command: string) => gradeProjectCall(root, root, classifyRisk, describeRisk, 'Bash', { command })

describe('project chat: running code asks', () => {
  it('a script file the model could have written is risky, with the reason', () => {
    for (const command of [
      'python evil.py',
      'python3 tower/render.py',
      'node build.js',
      'bun run scripts/x.ts',
      'bash setup.sh',
      './deploy.sh',
      '.\\make.ps1',
      'powershell -File make.ps1',
      'python -m tower.render',
      'ls && python evil.py',
    ]) expect(grade(command), command).toEqual({ level: 'risky', reason: RUNS_CODE_REASON })
  })

  it('inline code that reaches outside the folder asks too', () => {
    for (const command of [
      'python -c "import subprocess; subprocess.run([\'ls\'])"',
      'python -c "import urllib.request as u; u.urlopen(\'https://x\')"',
      'node -e "require(\'child_process\').exec(\'dir\')"',
    ]) expect(grade(command).level, command).toBe('risky')
  })

  it('what the user can read whole in the tool row stays as graded before', () => {
    expect(grade('python -c "print(400*1.1)"').level).toBe('safe')
    expect(grade('python --version').level).toBe('safe')
    expect(grade('ls').level).toBe('safe')
    expect(grade('git status').level).toBe('safe')
    expect(grade('echo hi').level).toBe('safe')
    expect(grade('cat notes.md').level).toBe('safe')
  })

  it('the ComfyUI fence and the download rule still come first', () => {
    expect(grade('python tower/render.py --server http://192.168.0.47:8188').reason).toBe(COMFY_FENCE_REASON)
    expect(grade('curl -O https://x/y.zip').reason).toBe('downloads need your approval')
    expect(grade('rm -rf knowledge').level).toBe('dangerous')
  })
})
