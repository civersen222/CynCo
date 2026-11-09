import { afterEach, describe, expect, it } from 'bun:test'
import { join } from 'path'
import { cyncoHome, missionsDir } from '../paths.js'

const saved = process.env.CYNCO_MISSIONS_DIR
afterEach(() => { if (saved === undefined) delete process.env.CYNCO_MISSIONS_DIR; else process.env.CYNCO_MISSIONS_DIR = saved })

describe('missionsDir', () => {
  it('defaults to <cyncoHome>/missions', () => {
    delete process.env.CYNCO_MISSIONS_DIR
    expect(missionsDir()).toBe(join(cyncoHome(), 'missions'))
  })
  it('follows CYNCO_MISSIONS_DIR, and treats an empty value as unset', () => {
    process.env.CYNCO_MISSIONS_DIR = 'D:/elsewhere/missions'
    expect(missionsDir()).toBe('D:/elsewhere/missions')
    process.env.CYNCO_MISSIONS_DIR = ''
    expect(missionsDir()).toBe(join(cyncoHome(), 'missions'))
  })
})
