// engine/llama/modelResolver.ts
import * as fs from 'fs'
import * as path from 'path'
import { ModelNotFoundError, AdapterNotFoundError } from './errors.js'

/**
 * Resolve a model name to a GGUF file path.
 *
 * Resolution order:
 * 1. Explicit modelPath (LOCALCODE_MODEL_PATH) — wins outright
 * 2. modelFile provided → use modelsDir/<modelName>/<modelFile> exactly; throw if absent
 * 3. No modelFile, folder has exactly one .gguf → use it
 * 4. No modelFile, folder has multiple .gguf → throw, listing candidates
 */
export function resolveModel(
  modelName: string,
  modelsDir: string,
  modelPath?: string,
  modelFile?: string,
): string {
  // 1. Explicit path override
  if (modelPath) {
    if (!fs.existsSync(modelPath)) {
      throw new Error(`LOCALCODE_MODEL_PATH does not exist: ${modelPath}`)
    }
    return modelPath
  }

  // Strip Ollama-style tags (e.g., "qwen3.6:latest" → "qwen3.6")
  const baseName = modelName.split(':')[0]
  const modelDir = path.join(modelsDir, baseName)
  if (!fs.existsSync(modelDir)) {
    throw new ModelNotFoundError(modelName, modelDir)
  }

  // 2. Explicit model_file → use it exactly
  if (modelFile) {
    const exact = path.join(modelDir, modelFile)
    if (!fs.existsSync(exact)) {
      throw new ModelNotFoundError(modelName, exact)
    }
    return exact
  }

  const entries = fs.readdirSync(modelDir)
  const ggufs = entries.filter(f => f.endsWith('.gguf'))

  if (ggufs.length === 0) {
    throw new ModelNotFoundError(modelName, modelDir)
  }

  // 3. Exactly one → unambiguous
  if (ggufs.length === 1) {
    return path.join(modelDir, ggufs[0])
  }

  // 4. Multiple → never silently pick. Force the user to disambiguate.
  throw new Error(
    `Multiple .gguf files in ${modelDir}: ${ggufs.join(', ')}. ` +
    `Set model_file in your profile to choose one.`,
  )
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

/**
 * Resolve a profile's `runtime.chat_template_file` to a file that exists.
 *
 * Nothing set: undefined (no --chat-template-file argument). An absolute path is used as written.
 * Anything else names a file beside the model's GGUF, the way `model_file` names a file inside the
 * model's folder, so a profile does not have to say where the models are. A file that is not there
 * throws: until 2026-11-23 the value went to llama-server verbatim, the server exited, and the
 * engine reported only "Process exited with code N" (F242).
 */
export function resolveChatTemplateFile(templateFile: string | undefined, modelPath: string): string | undefined {
  if (!templateFile) return undefined
  const modelDir = path.dirname(modelPath)
  const resolved = path.isAbsolute(templateFile) ? templateFile : path.join(modelDir, templateFile)
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `chat_template_file '${templateFile}' was looked for at ${resolved} and is not there. ` +
      `An absolute path is used as written (a leading ~ is not expanded); anything else names a file beside the model, in ${modelDir}.`,
    )
  }
  return resolved
}
