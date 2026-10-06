export type Segment = { heading: string[]; page?: number; chapter?: string; text: string }
export type Extracted = { ok: true; segments: Segment[] } | { ok: false; reason: string }
export type Extractor = (bytes: Uint8Array, fileName: string) => Promise<Extracted>
