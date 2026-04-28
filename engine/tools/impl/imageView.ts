import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { ToolImpl } from '../types.js'

export const imageViewTool: ToolImpl = {
  name: 'ImageView',
  description: 'Read an image file and encode it as base64 for vision-capable models. Supports PNG, JPG, GIF, WebP.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the image file' },
    },
    required: ['file_path'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const filePath = resolve(cwd, input.file_path as string)
    if (!existsSync(filePath)) return { output: `Error: image not found: ${filePath}`, isError: true }
    const ext = filePath.toLowerCase().split('.').pop() ?? ''
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    }
    const mime = mimeMap[ext]
    if (!mime) return { output: `Error: unsupported image format: .${ext}`, isError: true }
    try {
      const buf = readFileSync(filePath)
      const b64 = buf.toString('base64')
      return { output: JSON.stringify({ type: 'image', mime, base64: b64, path: filePath, size: buf.length }), isError: false }
    } catch (err) {
      return { output: `Error reading image: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
