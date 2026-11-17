// engine/llama/binaryManager.ts
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export const LLAMA_SERVER_BINARY = process.platform === 'win32'
  ? 'llama-server.exe'
  : 'llama-server'

export type VersionInfo = {
  version: string
  downloadedAt: string
}

/**
 * Resolve the llama-server binary path.
 *
 * Resolution order:
 * 1. Explicit envPath (LOCALCODE_LLAMA_SERVER) — must exist
 * 2. brainDir/llama-server[.exe] (e.g., ~/.cynco/bin-brain/) — the locally
 *    patched build (activation tap + toolcall logprobs). It sat unused for
 *    five weeks because nothing ever selected it: the J-Space readout needs
 *    the tap, and the stock binary silently downgraded the brain to
 *    entropy-only on every default launch.
 * 3. binDir/llama-server[.exe] (e.g., ~/.cynco/bin/)
 * 4. null — caller should trigger download or fall back
 */
export function resolveBinary(
  envPath: string | undefined,
  binDir: string,
  brainDir?: string,
): string | null {
  // 1. Explicit path
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`LOCALCODE_LLAMA_SERVER does not exist: ${envPath}`)
    }
    return envPath
  }

  // 2. ~/.cynco/bin-brain/ — patched build wins over stock
  if (brainDir) {
    const brainBin = path.join(brainDir, LLAMA_SERVER_BINARY)
    if (fs.existsSync(brainBin)) {
      return brainBin
    }
  }

  // 3. ~/.cynco/bin/
  const cyncoBin = path.join(binDir, LLAMA_SERVER_BINARY)
  if (fs.existsSync(cyncoBin)) {
    return cyncoBin
  }

  // 4. Not found
  return null
}

/**
 * Read version info from binDir/version.json.
 */
export function getVersionInfo(binDir: string): VersionInfo | null {
  const versionPath = path.join(binDir, 'version.json')
  try {
    const raw = fs.readFileSync(versionPath, 'utf-8')
    return JSON.parse(raw) as VersionInfo
  } catch {
    return null
  }
}

/**
 * Write version info after a successful download.
 */
export function writeVersionInfo(binDir: string, version: string): void {
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(
    path.join(binDir, 'version.json'),
    JSON.stringify({ version, downloadedAt: new Date().toISOString() }, null, 2),
  )
}

/**
 * The llama.cpp build a missing llama-server is downloaded as: the one in
 * `~/.cynco/bin` on the CynCo PC, which the profiles' tok/s figures, the
 * logprobs fallback (`provider.ts`) and the checkpoint log line the calibrator
 * reads were all measured against. The brain build (`bin-brain`) is the same
 * build with the activation-tap patch.
 *
 * It is a named build because "latest" is not one. GitHub's latest release of
 * llama.cpp was a placeholder holding one text file on 2026-09-25 (`v0.5.0`,
 * F161) and again on 2026-11-16 (`v1.0.0`, the day the project went to semantic
 * versions): no install without a binary could start (F238). Moving to a newer
 * build is a change to this line and a re-measurement, not something a download
 * decides.
 */
export const LLAMA_CPP_BUILD = 'b9529'

export const LLAMA_CPP_RELEASE_URL =
  `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_CPP_BUILD}`

export type ReleaseAsset = { name: string; browser_download_url: string }

/**
 * The server archive per platform, and on Windows the CUDA runtime that goes
 * with it, by exact name. Windows is the CUDA 12.4 pair, the one this PC's
 * stock binary is; the first asset matching a pattern depended on the order
 * GitHub lists them in. Linux has no CUDA build upstream: the Vulkan one is the
 * build that reaches a GPU there, and CynCo has not run it.
 */
const BUILD_ASSETS: Partial<Record<NodeJS.Platform, { server: string; runtime?: string }>> = {
  win32: {
    server: `llama-${LLAMA_CPP_BUILD}-bin-win-cuda-12.4-x64.zip`,
    runtime: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
  },
  linux: { server: `llama-${LLAMA_CPP_BUILD}-bin-ubuntu-vulkan-x64.tar.gz` },
}

/**
 * Which of a release's assets this platform needs. Throws with what the release
 * holds when the server archive is not among them, and for a platform with no
 * build; a runtime archive that is missing is `null` (the server may find CUDA
 * on the machine). Pure.
 */
export function pickReleaseAssets(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
): { server: ReleaseAsset; runtime: ReleaseAsset | null } {
  const wanted = BUILD_ASSETS[platform]
  if (!wanted) {
    throw new Error(
      `No llama-server download for platform ${platform} (llama.cpp ${LLAMA_CPP_BUILD}). ` +
      `Build or install llama-server and set LOCALCODE_LLAMA_SERVER to it.`
    )
  }
  const server = assets.find(a => a.name === wanted.server)
  if (!server) {
    const available = assets.map(a => a.name).join(', ') || 'nothing'
    throw new Error(
      `llama.cpp release ${LLAMA_CPP_BUILD} has no ${wanted.server}. It holds: ${available}. ` +
      `Set LOCALCODE_LLAMA_SERVER to a llama-server you have.`
    )
  }
  const runtime = wanted.runtime ? assets.find(a => a.name === wanted.runtime) ?? null : null
  // The names handed back are this file's own constants, not the release's text:
  // they become file names on disk.
  return {
    server: { name: wanted.server, browser_download_url: server.browser_download_url },
    runtime: runtime && wanted.runtime ? { name: wanted.runtime, browser_download_url: runtime.browser_download_url } : null,
  }
}

/**
 * The whole PowerShell text of an unpack. The two paths reach it through the
 * environment. `Stop` because Expand-Archive reports an archive it cannot read
 * as an error that does not end the command: without it PowerShell exits 0 and
 * a broken download reads as an unpacked one.
 */
const EXPAND_ARCHIVE_PS = "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:UNPACK_ARCHIVE -DestinationPath $env:UNPACK_DEST -Force"
const UNPACK_TIMEOUT_MS = 60_000 // measured 2026-11-17 on the CynCo PC: about 5 s for each Windows archive (249 MB, 373 MB)

/**
 * Unpack an archive into a folder, with no path ever part of a command line: on
 * Windows the paths are environment values that a fixed PowerShell text reads,
 * elsewhere they are `tar` arguments, and no shell reads either. The old form
 * pasted them between single quotes into a command string, so a home folder
 * with an apostrophe in its name ended the quote and the rest of the path was
 * run as PowerShell (CodeQL js/command-line-injection, PR #255). Throws with
 * the tool's own output when the archive cannot be unpacked.
 */
export function extractArchive(archivePath: string, destDir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', EXPAND_ARCHIVE_PS], {
      env: { ...process.env, UNPACK_ARCHIVE: archivePath, UNPACK_DEST: destDir },
      timeout: UNPACK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return
  }
  fs.mkdirSync(destDir, { recursive: true })
  execFileSync('tar', ['xzf', archivePath, '-C', destDir], { timeout: UNPACK_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Download llama-server from llama.cpp GitHub releases.
 *
 * 1. Ask GitHub for the pinned build's release (`LLAMA_CPP_BUILD`)
 * 2. Take this platform's archive from it by name (`pickReleaseAssets`)
 * 3. Download and extract llama-server binary
 * 4. Write version.json
 *
 * Returns the path to the downloaded binary. Nothing is written before the
 * release is known to hold the build. `fetchImpl` is the seam the tests use.
 */
export async function downloadBinary(
  binDir: string,
  onProgress?: (msg: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const log = onProgress ?? console.log

  log(`[llama-cpp] Asking GitHub for llama.cpp ${LLAMA_CPP_BUILD}...`)
  const releaseResp = await fetchImpl(
    LLAMA_CPP_RELEASE_URL,
    { headers: { 'Accept': 'application/vnd.github.v3+json' } },
  )
  if (!releaseResp.ok) {
    throw new Error(`GitHub API returned ${releaseResp.status}: ${await releaseResp.text()}`)
  }
  const release = await releaseResp.json() as {
    tag_name: string
    assets: ReleaseAsset[]
  }

  const { server: asset, runtime: cudartAsset } = pickReleaseAssets(release.assets, process.platform)

  log(`[llama-cpp] Downloading ${asset.name} (${release.tag_name})...`)
  const downloadResp = await fetchImpl(asset.browser_download_url)
  if (!downloadResp.ok) {
    throw new Error(`Download failed: ${downloadResp.status}`)
  }
  const arrayBuffer = await downloadResp.arrayBuffer()
  const zipPath = path.join(binDir, asset.name)

  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(zipPath, Buffer.from(arrayBuffer))

  log(`[llama-cpp] Extracting ${LLAMA_SERVER_BINARY}...`)

  // Extract using system tools
  const destPath = path.join(binDir, LLAMA_SERVER_BINARY)
  if (process.platform === 'win32') {
    const extractDir = path.join(binDir, '_extract')
    extractArchive(zipPath, extractDir)
    // Find llama-server.exe in extracted contents (may be nested)
    const found = findFileRecursive(extractDir, LLAMA_SERVER_BINARY)
    if (!found) {
      throw new Error(`${LLAMA_SERVER_BINARY} not found in extracted archive`)
    }
    fs.copyFileSync(found, destPath)
    // Also copy DLLs that llama-server needs (CUDA, etc.)
    const extractedDir = path.dirname(found)
    for (const f of fs.readdirSync(extractedDir)) {
      if (f.endsWith('.dll')) {
        fs.copyFileSync(path.join(extractedDir, f), path.join(binDir, f))
      }
    }
    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true })
  } else {
    extractArchive(zipPath, binDir)
    const found = findFileRecursive(binDir, LLAMA_SERVER_BINARY)
    if (found && found !== destPath) {
      fs.renameSync(found, destPath)
      fs.chmodSync(destPath, 0o755)
    }
  }

  // Cleanup archive
  fs.rmSync(zipPath, { force: true })

  // Download matching CUDA runtime DLLs (separate zip in llama.cpp releases)
  if (process.platform === 'win32') {
    if (cudartAsset) {
      log(`[llama-cpp] Downloading CUDA runtime: ${cudartAsset.name}...`)
      try {
        const cudartResp = await fetchImpl(cudartAsset.browser_download_url)
        if (cudartResp.ok) {
          const cudartBuf = await cudartResp.arrayBuffer()
          const cudartZip = path.join(binDir, cudartAsset.name)
          fs.writeFileSync(cudartZip, Buffer.from(cudartBuf))
          const cudartExtract = path.join(binDir, '_cudart')
          extractArchive(cudartZip, cudartExtract)
          // Copy all DLLs from cudart archive
          for (const f of fs.readdirSync(cudartExtract)) {
            if (f.endsWith('.dll')) {
              fs.copyFileSync(path.join(cudartExtract, f), path.join(binDir, f))
            }
          }
          fs.rmSync(cudartExtract, { recursive: true, force: true })
          fs.rmSync(cudartZip, { force: true })
          log(`[llama-cpp] CUDA runtime installed`)
        }
      } catch (e) {
        log(`[llama-cpp] CUDA runtime download failed (non-fatal): ${e}`)
      }
    }
  }

  writeVersionInfo(binDir, release.tag_name)
  log(`[llama-cpp] Downloaded llama-server ${release.tag_name} to ${binDir}`)

  return destPath
}

function findFileRecursive(dir: string, filename: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, filename)
      if (found) return found
    } else if (entry.name === filename) {
      return full
    }
  }
  return null
}
