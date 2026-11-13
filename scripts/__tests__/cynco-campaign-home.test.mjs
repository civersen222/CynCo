import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { campaignHome, homeProblems, expandPath, CIVKINGS_HOME, HOME_KEYS, legacySpecPath } from '../cynco-campaign-home.mjs'
import { loadCampaignSpec } from '../cynco-campaign-spec.mjs'
import { ROADMAP_PATH } from '../cynco-roadmap.mjs'

const home = homedir().replace(/\\/g, '/')
const yes = () => true, no = () => false

describe('campaignHome', () => {
  it('fills every absent key with today\'s CivKings value', () => {
    const h = campaignHome({ repo: 'C:/Users/civer/civkings' }, { exists: yes })
    expect(h).toEqual({
      repo: 'C:/Users/civer/civkings',
      briefsDir: 'docs/civkings-redesign-briefs',
      campaignLog: 'docs/civkings-redesign-briefs/campaign-log.md',
      heldoutFamily: 'civkings-redesign',
      roadmap: 'docs/civkings-redesign-briefs/roadmap.json',
      suiteTarget: 'gilded/tests',
      defaulted: HOME_KEYS,
    })
    // The derived roadmap IS the runner's old constant, so c8..c11 move the same line.
    expect(h.roadmap).toBe(ROADMAP_PATH)
  })

  it('derives the log and the roadmap from a declared briefsDir, and expands ~/', () => {
    const h = campaignHome({ repo: 'C:\\Users\\civer\\casino', briefsDir: '~/.cynco/campaigns/partynight', heldoutFamily: 'partynight', suiteTarget: null, markerCheck: 'npx vitest run' }, { exists: yes })
    expect(h.repo).toBe('C:/Users/civer/casino')
    expect(h.briefsDir).toBe(`${home}/.cynco/campaigns/partynight`)
    expect(h.campaignLog).toBe(`${home}/.cynco/campaigns/partynight/campaign-log.md`)
    expect(h.roadmap).toBe(`${home}/.cynco/campaigns/partynight/roadmap.json`)
    expect(h.heldoutFamily).toBe('partynight')
    expect(h.suiteTarget).toBeNull()
    expect(h.defaulted).toEqual(['campaignLog', 'roadmap'])
  })

  it('has no roadmap when the derived one does not exist, or when the spec says null', () => {
    expect(campaignHome({ repo: 'r', briefsDir: 'x' }, { exists: no }).roadmap).toBeNull()
    expect(campaignHome({ repo: 'r', roadmap: null }, { exists: yes }).roadmap).toBeNull()
    // A NAMED roadmap is used as named; the runner logs a file it cannot read.
    expect(campaignHome({ repo: 'r', roadmap: '~/plans/roadmap.json' }, { exists: no }).roadmap).toBe(`${home}/plans/roadmap.json`)
  })

  it('keeps a relative path relative (resolved against the checkout, as before)', () => {
    expect(expandPath('docs\\x')).toBe('docs/x')
    expect(expandPath('~')).toBe(home)
    expect(legacySpecPath('c11')).toBe('docs/civkings-redesign-briefs/c11.campaign.json')
    expect(CIVKINGS_HOME.repo).toBe('C:/Users/civer/civkings')
  })
})

describe('homeProblems', () => {
  it('says nothing about a spec with no home keys', () => {
    expect(homeProblems({ repo: 'r' })).toEqual([])
  })
  it('refuses empty paths, a family that is not one folder name, and a bad roadmap', () => {
    expect(homeProblems({ briefsDir: '' })[0]).toMatch(/briefsDir must be a non-empty path/)
    expect(homeProblems({ campaignLog: 7 })[0]).toMatch(/campaignLog must be a non-empty path/)
    for (const bad of ['', '../x', 'a/b', 'a b', '.hidden', 7]) expect(homeProblems({ heldoutFamily: bad })[0]).toMatch(/heldoutFamily must be one folder name/)
    expect(homeProblems({ heldoutFamily: 'party-night_2.v1' })).toEqual([])
    expect(homeProblems({ roadmap: '' })[0]).toMatch(/roadmap must be a non-empty path, or null/)
    expect(homeProblems({ roadmap: null })).toEqual([])
  })
  it('holds suiteTarget to the suite gate\'s terms, and a null one to naming its own markerCheck', () => {
    expect(homeProblems({ suiteTarget: 'tests' })).toEqual([])
    expect(homeProblems({ suiteTarget: '' })[0]).toMatch(/suiteTarget must be a non-empty pytest target/)
    expect(homeProblems({ suiteTarget: 'a b' })[0]).toMatch(/whitespace/)
    expect(homeProblems({ suiteTarget: 'tests/test_*.py' })[0]).toMatch(/wildcard/)
    expect(homeProblems({ suiteTarget: null })[0]).toMatch(/must name its own markerCheck/)
    expect(homeProblems({ suiteTarget: null, markerCheck: 'npx vitest run' })).toEqual([])
  })
})

// The specs checked into this repo predate the home keys and must keep loading,
// unedited, to the CivKings home (the brief's acceptance: c8..c11 still load).
describe('the checked-in CivKings specs', () => {
  for (const id of ['c8', 'c9', 'c10', 'c11']) {
    it(`${id}.campaign.json loads and resolves to the CivKings home`, () => {
      const spec = loadCampaignSpec(legacySpecPath(id))
      expect(spec.id).toBe(id)
      for (const k of HOME_KEYS) expect(spec[k]).toBeUndefined()
      const h = campaignHome(spec)
      expect(h.briefsDir).toBe('docs/civkings-redesign-briefs')
      expect(h.campaignLog).toBe('docs/civkings-redesign-briefs/campaign-log.md')
      expect(h.heldoutFamily).toBe('civkings-redesign')
      expect(h.roadmap).toBe(ROADMAP_PATH)
      expect(h.suiteTarget).toBe('gilded/tests')
      expect(h.repo).toBe('C:/Users/civer/civkings')
    })
  }
})
