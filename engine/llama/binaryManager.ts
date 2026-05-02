// engine/llama/binaryManager.ts
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
 * 2. binDir/llama-server[.exe] (e.g., ~/.cynco/bin/)
 * 3. null — caller should trigger download or fall back
 */
export function resolveBinary(
  envPath: string | undefined,
  binDir: string,
): string | null {
  // 1. Explicit path
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`LOCALCODE_LLAMA_SERVER does not exist: ${envPath}`)
    }
    return envPath
  }

  // 2. ~/.cynco/bin/
  const cyncoBin = path.join(binDir, LLAMA_SERVER_BINARY)
  if (fs.existsSync(cyncoBin)) {
    return cyncoBin
  }

  // 3. Not found
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
 * Download llama-server from llama.cpp GitHub releases.
 *
 * 1. Query GitHub API for latest release
 * 2. Find asset matching platform (win-cuda-x64)
 * 3. Download and extract llama-server binary
 * 4. Write version.json
 *
 * Returns the path to the downloaded binary.
 */
export async function downloadBinary(
  binDir: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const log = onProgress ?? console.log

  log('[llama-cpp] Querying GitHub for latest llama.cpp release...')
  const releaseResp = await fetch(
    'https://api.github.com/repos/ggerganov/llama.cpp/releases/latest',
    { headers: { 'Accept': 'application/vnd.github.v3+json' } },
  )
  if (!releaseResp.ok) {
    throw new Error(`GitHub API returned ${releaseResp.status}: ${await releaseResp.text()}`)
  }
  const release = await releaseResp.json() as {
    tag_name: string
    assets: Array<{ name: string; browser_download_url: string }>
  }

  // Find the right asset for this platform
  const assetPattern = process.platform === 'win32'
    ? /llama-.*-bin-win-cuda-.*-x64\.zip/
    : /llama-.*-bin-ubuntu-.*-x64\.tar\.gz/
  const asset = release.assets.find(a => assetPattern.test(a.name))
  if (!asset) {
    const available = release.assets.map(a => a.name).join(', ')
    throw new Error(
      `No matching llama-server binary found in release ${release.tag_name}. ` +
      `Pattern: ${assetPattern}. Available: ${available}`
    )
  }

  log(`[llama-cpp] Downloading ${asset.name} (${release.tag_name})...`)
  const downloadResp = await fetch(asset.browser_download_url)
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
    // Use PowerShell to extract on Windows
    const { execSync } = require('child_process')
    const extractDir = path.join(binDir, '_extract')
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { timeout: 60000 },
    )
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
    const { execSync } = require('child_process')
    execSync(`tar xzf '${zipPath}' -C '${binDir}'`, { timeout: 60000 })
    const found = findFileRecursive(binDir, LLAMA_SERVER_BINARY)
    if (found && found !== destPath) {
      fs.renameSync(found, destPath)
      fs.chmodSync(destPath, 0o755)
    }
  }

  // Cleanup archive
  fs.rmSync(zipPath, { force: true })

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
