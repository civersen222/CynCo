import { zipSync, strToU8 } from 'fflate'

/** A minimal, valid PDF with one text line per page (Helvetica, no compression). */
export function pdfWithPages(pageTexts: string[]): Uint8Array {
  const objects: string[] = []
  const add = (s: string) => { objects.push(s); return objects.length }
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageIds: number[] = []
  const pagesId = objects.length + 1 + pageTexts.length * 2 // reserved after all page+content objects
  for (const text of pageTexts) {
    const esc = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`)
    pageIds.push(pageId)
  }
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)
  if (realPagesId !== pagesId) throw new Error(`fixture bug: pages id ${realPagesId} != ${pagesId}`)
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** A one-page PDF whose page has no content stream: a stand-in for a scan. */
export function scannedPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 4\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** A two-chapter EPUB 2 with container.xml, an OPF spine and XHTML chapters. */
export function epubWithChapters(chapters: { title: string; html: string }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  files['mimetype'] = strToU8('application/epub+zip')
  files['META-INF/container.xml'] = strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  const items = chapters.map((c, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')
  const spine = chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('')
  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Fixture</dc:title></metadata><manifest>${items}</manifest><spine>${spine}</spine></package>`)
  chapters.forEach((c, i) => {
    files[`OEBPS/ch${i + 1}.xhtml`] = strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c.title}</title></head><body>${c.html}</body></html>`)
  })
  return zipSync(files, { level: 0 })
}
