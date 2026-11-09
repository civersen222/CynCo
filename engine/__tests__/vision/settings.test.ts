import { describe, expect, it } from 'bun:test'
import { visionSettings } from '../../vision/settings.js'

describe('visionSettings', () => {
  it('is off unless LOCALCODE_VISION_URL is set; the model defaults', () => {
    expect(visionSettings({})).toEqual({ url: null, model: 'qwen3-vl:8b-instruct' })
    expect(visionSettings({ LOCALCODE_VISION_URL: '  ' }).url).toBeNull()
  })
  it('reads both, drops a trailing slash', () => {
    expect(visionSettings({ LOCALCODE_VISION_URL: 'http://192.168.0.47:11434/', LOCALCODE_VISION_MODEL: 'gemma3:12b' }))
      .toEqual({ url: 'http://192.168.0.47:11434', model: 'gemma3:12b' })
  })
})
