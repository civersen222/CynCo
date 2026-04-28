/**
 * S4 Adaptation: Load prompt templates from files.
 * Global: ~/.cynco/prompts/
 * Project: .cynco/prompts/ (overrides global)
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export type Template = {
  name: string
  content: string
  source: 'global' | 'project'
}

export class TemplateLoader {
  private globalDir: string
  private projectDir: string

  constructor(projectRoot?: string) {
    this.globalDir = join(homedir(), '.cynco', 'prompts')
    this.projectDir = join(projectRoot ?? process.cwd(), '.cynco', 'prompts')
  }

  /** Load a named template. Project-local overrides global. */
  load(name: string): Template | null {
    const projectPath = join(this.projectDir, `${name}.md`)
    if (existsSync(projectPath)) {
      return { name, content: readFileSync(projectPath, 'utf-8'), source: 'project' }
    }
    const globalPath = join(this.globalDir, `${name}.md`)
    if (existsSync(globalPath)) {
      return { name, content: readFileSync(globalPath, 'utf-8'), source: 'global' }
    }
    return null
  }

  /** Load system.md extension — appended to system prompt if it exists. */
  loadSystemExtension(): string | null {
    const tmpl = this.load('system')
    return tmpl?.content ?? null
  }

  /** List all available template names. */
  list(): string[] {
    const names = new Set<string>()
    for (const dir of [this.globalDir, this.projectDir]) {
      if (existsSync(dir)) {
        try {
          for (const file of readdirSync(dir)) {
            if (file.endsWith('.md')) names.add(file.replace('.md', ''))
          }
        } catch {}
      }
    }
    return [...names].sort()
  }

  /** Substitute arguments into template: $1, $2, $ARGUMENTS */
  substitute(content: string, args: string): string {
    const parts = args.split(/\s+/).filter(p => p)
    let result = content.replace(/\$ARGUMENTS/g, args)
    parts.forEach((part, i) => {
      result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), part)
    })
    return result
  }
}
