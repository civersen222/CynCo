import { describe, it, expect } from 'bun:test'
import { validateCommand } from '../../bridge/commandSchema.js'
import { dashboardCommandRefusal } from '../../dashboard/server.js'

describe('project.open', () => {
  it('accepts a slug or null, an optional chat, refuses the rest by name', () => {
    expect(validateCommand({ type: 'project.open', slug: 'diorama' }).ok).toBe(true)
    expect(validateCommand({ type: 'project.open', slug: null }).ok).toBe(true)
    expect(validateCommand({ type: 'project.open', slug: 'd', chat: '20261005T120000-x.jsonl' }).ok).toBe(true)
    const bad = validateCommand({ type: 'project.open', slug: 7 })
    expect(bad.ok).toBe(false); if (!bad.ok) expect(bad.reason).toMatch(/slug/)
    const badChat = validateCommand({ type: 'project.open', slug: 'd', chat: '../x' })
    expect(badChat.ok).toBe(false); if (!badChat.ok) expect(badChat.reason).toMatch(/chat/)
  })
  it('is allowed on the dashboard socket', () => {
    expect(dashboardCommandRefusal({ type: 'project.open', slug: 'd' })).toBeNull()
  })
})
