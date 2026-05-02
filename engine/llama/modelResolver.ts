// engine/llama/modelResolver.ts
import * as fs from 'fs'
import * as path from 'path'
import { ModelNotFoundError, AdapterNotFoundError } from './errors.js'

/**
 * Resolve a model name to a GGUF file path.
 *
 * Resolution order:
 * 1. Explicit modelPath (LOCALCODE_MODEL_PATH) — wins outright
 * 2. modelsDir/<modelName>/*.gguf — pick largest file
 * 3. Error with download instructions
 */
export function resolveModel(
  modelName: string,
  modelsDir: string,
  modelPath?: string,
): string {
  // 1. Explicit path override
  if (modelPath) {
    if (!fs.existsSync(modelPath)) {
      throw new Error(`LOCALCODE_MODEL_PATH does not exist: ${modelPath}`)
    }
    return modelPath
  }

  // 2. Scan modelsDir/<modelName>/*.gguf
  // Strip Ollama-style tags (e.g., "qwen3.6:latest" → "qwen3.6")
  const baseName = modelName.split(':')[0]
  const modelDir = path.join(modelsDir, baseName)
  if (!fs.existsSync(modelDir)) {
    throw new ModelNotFoundError(modelName, modelDir)
  }

  const entries = fs.readdirSync(modelDir)
  const ggufs = entries
    .filter(f => f.endsWith('.gguf'))
    .map(f => {
      const fullPath = path.join(modelDir, f)
      const stat = fs.statSync(fullPath)
      return { path: fullPath, size: stat.size }
    })
    .sort((a, b) => b.size - a.size) // largest first

  if (ggufs.length === 0) {
    throw new ModelNotFoundError(modelName, modelDir)
  }

  return ggufs[0].path
}

/**
 * Resolve an adapter name to a GGUF file path.
 * Looks for <adaptersDir>/<name>.gguf
 */
export function resolveAdapter(
  adapterName: string,
  adaptersDir: string,
): string {
  const adapterPath = path.join(adaptersDir, `${adapterName}.gguf`)
  if (!fs.existsSync(adapterPath)) {
    throw new AdapterNotFoundError(adapterName, adapterPath)
  }
  return adapterPath
}
