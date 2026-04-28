import { describe, expect, it } from 'bun:test'
import { checkBashSafety } from '../../tools/bashSafety.js'

describe('Bash Safety', () => {
  it('allows normal commands', () => {
    expect(checkBashSafety('echo hello').safe).toBe(true)
    expect(checkBashSafety('bun test').safe).toBe(true)
    expect(checkBashSafety('git status').safe).toBe(true)
  })

  it('blocks .env file access', () => {
    expect(checkBashSafety('cat .env').safe).toBe(false)
    expect(checkBashSafety('cat .env.local').safe).toBe(false)
    expect(checkBashSafety('echo SECRET=x >> .env').safe).toBe(false)
  })

  it('blocks credential file access', () => {
    expect(checkBashSafety('cat ~/.ssh/id_rsa').safe).toBe(false)
    expect(checkBashSafety('cat /etc/shadow').safe).toBe(false)
  })

  it('blocks destructive system commands', () => {
    expect(checkBashSafety('rm -rf /').safe).toBe(false)
    expect(checkBashSafety('rm -rf ~').safe).toBe(false)
    expect(checkBashSafety('mkfs.ext4 /dev/sda').safe).toBe(false)
  })

  it('blocks commands that leak env vars', () => {
    expect(checkBashSafety('env').safe).toBe(false)
    expect(checkBashSafety('printenv').safe).toBe(false)
    expect(checkBashSafety('echo $SECRET_KEY').safe).toBe(false)
  })

  it('returns reason when blocked', () => {
    const result = checkBashSafety('cat .env')
    expect(result.reason).toContain('.env')
  })
})
