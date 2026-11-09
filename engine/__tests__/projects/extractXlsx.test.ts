// xlsx extraction: one segment per sheet, rows as `a | b | c` (wakefulness slice 5).
import { describe, expect, it } from 'bun:test'
import { makeZip } from './extractOffice.test.js'
import { extractXlsx } from '../../projects/extract/xlsx.js'
import { extractFile, ACCEPTED_EXTS } from '../../projects/extract/index.js'

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Roster" sheetId="1" r:id="rId1"/><sheet name="Picks 2026" sheetId="2" r:id="rId2"/></sheets></workbook>`
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="x/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
const SHARED = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Player</t></si><si><r><t>Pu</t></r><r><t>ka</t></r></si><si><t>A &amp; B</t></si></sst>`
const SHEET1 = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Proj</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>14.2</v></c><c r="C2" t="b"><v>1</v></c><c r="D2"/></row>
<row r="3"><c r="A3" t="s"><v>2</v></c></row>
</sheetData></worksheet>`
const SHEET2 = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`

function xlsx(extra: Record<string, string> = {}) {
  return makeZip({ 'xl/workbook.xml': WORKBOOK, 'xl/_rels/workbook.xml.rels': RELS, 'xl/sharedStrings.xml': SHARED, 'xl/worksheets/sheet1.xml': SHEET1, 'xl/worksheets/sheet2.xml': SHEET2, ...extra }, { deflate: true })
}

describe('extractXlsx', () => {
  it('one segment per sheet, in workbook order, named from workbook.xml via the rels', async () => {
    const r = await extractXlsx(xlsx(), 'league.xlsx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.segments.map(s => s.heading)).toEqual([['league.xlsx', 'Roster'], ['league.xlsx', 'Picks 2026']])
    expect(r.segments[0].text).toBe('Player | Proj\nPuka | 14.2 | TRUE\nA & B')
    expect(r.segments[1].text).toBe('7')
  })
  it('caps rows per sheet and says how many more there were', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')
    const big = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
    const r = await extractXlsx(xlsx({ 'xl/worksheets/sheet2.xml': big }), 'b.xlsx', { maxRows: 10 } as any)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.segments[1].text.split('\n').length).toBe(11)
    expect(r.segments[1].text).toContain('… 2 more rows')
  })
  it('a zip without xl/workbook.xml is refused with a reason', async () => {
    const r = await extractXlsx(makeZip({ 'a.txt': 'x' }), 'x.xlsx')
    expect(r).toEqual({ ok: false, reason: 'not an xlsx: xl/workbook.xml missing' })
  })
  it('is registered for .xlsx', async () => {
    expect(ACCEPTED_EXTS.has('.xlsx')).toBe(true)
    const r = await extractFile(xlsx(), 'n.xlsx')
    expect(r.ok).toBe(true)
  })
})
