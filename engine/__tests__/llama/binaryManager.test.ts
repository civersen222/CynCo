// engine/__tests__/llama/binaryManager.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import {
  resolveBinary,
  getVersionInfo,
  downloadBinary,
  pickReleaseAssets,
  LLAMA_SERVER_BINARY,
  LLAMA_CPP_BUILD,
  LLAMA_CPP_RELEASE_URL,
} from '../../llama/binaryManager.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/** The b9529 release's assets as GitHub listed them on 2026-11-16, in its order. */
const B9529_ASSET_NAMES = [
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.3-x64.zip',
  'llama-b9529-bin-android-arm64.tar.gz',
  'llama-b9529-bin-macos-arm64.tar.gz',
  'llama-b9529-bin-macos-x64.tar.gz',
  'llama-b9529-bin-ubuntu-arm64.tar.gz',
  'llama-b9529-bin-ubuntu-openvino-2026.0-x64.tar.gz',
  'llama-b9529-bin-ubuntu-rocm-7.2-x64.tar.gz',
  'llama-b9529-bin-ubuntu-s390x.tar.gz',
  'llama-b9529-bin-ubuntu-vulkan-arm64.tar.gz',
  'llama-b9529-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b9529-bin-ubuntu-x64.tar.gz',
  'llama-b9529-bin-win-cpu-arm64.zip',
  'llama-b9529-bin-win-cpu-x64.zip',
  'llama-b9529-bin-win-cuda-12.4-x64.zip',
  'llama-b9529-bin-win-cuda-13.3-x64.zip',
  'llama-b9529-bin-win-hip-radeon-x64.zip',
  'llama-b9529-bin-win-opencl-adreno-arm64.zip',
  'llama-b9529-bin-win-vulkan-x64.zip',
  'llama-b9529-ui.tar.gz',
  'llama-b9529-xcframework.zip',
]
const asAssets = (names: string[]) => names.map(name => ({ name, browser_download_url: `https://example.invalid/${name}` }))
/** What `releases/latest` held on 2026-11-16 (`v1.0.0`), and on 2026-09-25 (`v0.5.0`, F161): one text file. */
const PLACEHOLDER_RELEASE = { tag_name: 'v1.0.0', assets: asAssets(['nightly-tag.txt']) }

describe('the llama-server download is one named build (F238)', () => {
  it('asks GitHub for the pinned tag, never for "latest"', () => {
    expect(LLAMA_CPP_BUILD).toBe('b9529')
    expect(LLAMA_CPP_RELEASE_URL).toBe('https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b9529')
  })

  it('on Windows takes the CUDA 12.4 server and the CUDA 12.4 runtime: the pair in ~/.cynco/bin', () => {
    const picked = pickReleaseAssets(asAssets(B9529_ASSET_NAMES), 'win32')
    expect(picked.server.name).toBe('llama-b9529-bin-win-cuda-12.4-x64.zip')
    expect(picked.runtime?.name).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip')
  })

  it('does not depend on the order GitHub lists the assets in', () => {
    const picked = pickReleaseAssets(asAssets([...B9529_ASSET_NAMES].reverse()), 'win32')
    expect(picked.server.name).toBe('llama-b9529-bin-win-cuda-12.4-x64.zip')
    expect(picked.runtime?.name).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip')
  })

  it('on Linux takes the Vulkan x64 build, not the first tarball with "ubuntu" in its name', () => {
    const picked = pickReleaseAssets(asAssets(B9529_ASSET_NAMES), 'linux')
    expect(picked.server.name).toBe('llama-b9529-bin-ubuntu-vulkan-x64.tar.gz')
    expect(picked.runtime).toBeNull()
  })

  it('a release without the build says what it holds and what to set instead', () => {
    expect(() => pickReleaseAssets(PLACEHOLDER_RELEASE.assets, 'win32'))
      .toThrow(/llama-b9529-bin-win-cuda-12\.4-x64\.zip.*nightly-tag\.txt.*LOCALCODE_LLAMA_SERVER/s)
  })

  it('a server zip with no runtime zip beside it still resolves', () => {
    const picked = pickReleaseAssets(asAssets(['llama-b9529-bin-win-cuda-12.4-x64.zip']), 'win32')
    expect(picked.server.name).toBe('llama-b9529-bin-win-cuda-12.4-x64.zip')
    expect(picked.runtime).toBeNull()
  })

  it('refuses a platform it has no build for, by name', () => {
    expect(() => pickReleaseAssets(asAssets(B9529_ASSET_NAMES), 'darwin'))
      .toThrow(/darwin.*LOCALCODE_LLAMA_SERVER/s)
  })
})

describe('downloadBinary', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-dl-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('asks for the pinned release only, and a release without the build stops it before anything is written', async () => {
    const asked: string[] = []
    const fetchStub = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return new Response(JSON.stringify(PLACEHOLDER_RELEASE), { status: 200 })
    }) as typeof fetch
    await expect(downloadBinary(tmpDir, () => {}, fetchStub)).rejects.toThrow(/nightly-tag\.txt/)
    expect(asked).toEqual([LLAMA_CPP_RELEASE_URL])
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })

  it('a GitHub refusal is passed on with its status', async () => {
    const fetchStub = (async () => new Response('rate limited', { status: 403 })) as typeof fetch
    await expect(downloadBinary(tmpDir, () => {}, fetchStub)).rejects.toThrow(/403/)
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })
})

describe('resolveBinary', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-bin-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns explicit env path when set and file exists', () => {
    const binPath = path.join(tmpDir, LLAMA_SERVER_BINARY)
    fs.writeFileSync(binPath, 'fake-binary')
    const result = resolveBinary(binPath, tmpDir)
    expect(result).toBe(binPath)
  })

  it('throws when explicit env path does not exist', () => {
    expect(() => resolveBinary('/nonexistent/llama-server.exe', tmpDir))
      .toThrow('does not exist')
  })

  it('returns cynco bin path when binary exists there', () => {
    const binPath = path.join(tmpDir, LLAMA_SERVER_BINARY)
    fs.writeFileSync(binPath, 'fake-binary')
    const result = resolveBinary(undefined, tmpDir)
    expect(result).toBe(binPath)
  })

  it('returns null when binary not found anywhere', () => {
    const result = resolveBinary(undefined, tmpDir)
    expect(result).toBeNull()
  })

  it('prefers the brain build over the stock binary when both exist', () => {
    const binDir = path.join(tmpDir, 'bin')
    const brainDir = path.join(tmpDir, 'bin-brain')
    fs.mkdirSync(binDir)
    fs.mkdirSync(brainDir)
    fs.writeFileSync(path.join(binDir, LLAMA_SERVER_BINARY), 'stock')
    fs.writeFileSync(path.join(brainDir, LLAMA_SERVER_BINARY), 'patched')
    expect(resolveBinary(undefined, binDir, brainDir))
      .toBe(path.join(brainDir, LLAMA_SERVER_BINARY))
  })

  it('falls back to the stock binary when the brain dir has no binary', () => {
    const binDir = path.join(tmpDir, 'bin')
    const brainDir = path.join(tmpDir, 'bin-brain')
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(binDir, LLAMA_SERVER_BINARY), 'stock')
    expect(resolveBinary(undefined, binDir, brainDir))
      .toBe(path.join(binDir, LLAMA_SERVER_BINARY))
  })

  it('explicit env path outranks the brain build', () => {
    const brainDir = path.join(tmpDir, 'bin-brain')
    fs.mkdirSync(brainDir)
    fs.writeFileSync(path.join(brainDir, LLAMA_SERVER_BINARY), 'patched')
    const envBin = path.join(tmpDir, LLAMA_SERVER_BINARY)
    fs.writeFileSync(envBin, 'explicit')
    expect(resolveBinary(envBin, tmpDir, brainDir)).toBe(envBin)
  })

  it('LLAMA_SERVER_BINARY is llama-server.exe on Windows', () => {
    if (process.platform === 'win32') {
      expect(LLAMA_SERVER_BINARY).toBe('llama-server.exe')
    } else {
      expect(LLAMA_SERVER_BINARY).toBe('llama-server')
    }
  })
})

describe('getVersionInfo', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-ver-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no version.json exists', () => {
    expect(getVersionInfo(tmpDir)).toBeNull()
  })

  it('reads version info from version.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'version.json'),
      JSON.stringify({ version: 'b5432', downloadedAt: '2026-05-02T10:00:00Z' })
    )
    const info = getVersionInfo(tmpDir)
    expect(info).not.toBeNull()
    expect(info!.version).toBe('b5432')
    expect(info!.downloadedAt).toBe('2026-05-02T10:00:00Z')
  })
})
