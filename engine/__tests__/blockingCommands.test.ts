import { describe, it, expect } from 'vitest'
import { checkBashSafety } from '../tools/bashSafety.js'

describe('blocking command detection', () => {
  describe('bare REPLs are blocked', () => {
    it('blocks bare python', () => {
      const result = checkBashSafety('python')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/REPL/)
    })

    it('blocks bare python3', () => {
      const result = checkBashSafety('python3')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/REPL/)
    })

    it('blocks bare node', () => {
      const result = checkBashSafety('node')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/REPL/)
    })

    it('blocks bare bun', () => {
      const result = checkBashSafety('bun')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/REPL/)
    })
  })

  describe('server scripts are blocked', () => {
    it('blocks python app.py', () => {
      const result = checkBashSafety('python app.py')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })

    it('blocks node server.js', () => {
      const result = checkBashSafety('node server.js')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })

    it('blocks python3 app.py', () => {
      const result = checkBashSafety('python3 app.py')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })
  })

  describe('dev server commands are blocked', () => {
    it('blocks npm start', () => {
      const result = checkBashSafety('npm start')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })

    it('blocks bun run dev', () => {
      const result = checkBashSafety('bun run dev')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })

    it('blocks uvicorn main:app', () => {
      const result = checkBashSafety('uvicorn main:app')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })

    it('blocks flask run', () => {
      const result = checkBashSafety('flask run')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })

    it('blocks next dev', () => {
      const result = checkBashSafety('next dev')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })

    it('blocks vite dev', () => {
      const result = checkBashSafety('vite dev')
      expect(result.safe).toBe(false)
      expect(result.reason).toMatch(/server/)
    })
  })

  describe('safe commands are allowed', () => {
    it('allows python -m pytest', () => {
      const result = checkBashSafety('python -m pytest')
      expect(result.safe).toBe(true)
    })

    it('allows node --check server.js', () => {
      const result = checkBashSafety('node --check server.js')
      expect(result.safe).toBe(true)
    })

    it('allows npm test', () => {
      const result = checkBashSafety('npm test')
      expect(result.safe).toBe(true)
    })

    it('allows python --version', () => {
      const result = checkBashSafety('python --version')
      expect(result.safe).toBe(true)
    })

    it('allows python app.py & (background)', () => {
      const result = checkBashSafety('python app.py &')
      expect(result.safe).toBe(true)
    })

    it('allows python script.py', () => {
      const result = checkBashSafety('python script.py')
      expect(result.safe).toBe(true)
    })

    it('allows node build.js', () => {
      const result = checkBashSafety('node build.js')
      expect(result.safe).toBe(true)
    })

    it('allows ls -la', () => {
      const result = checkBashSafety('ls -la')
      expect(result.safe).toBe(true)
    })

    it('allows git status', () => {
      const result = checkBashSafety('git status')
      expect(result.safe).toBe(true)
    })
  })
})
