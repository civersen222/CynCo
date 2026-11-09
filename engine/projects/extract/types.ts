export type Segment = { heading: string[]; page?: number; chapter?: string; text: string }
export type Extracted = { ok: true; segments: Segment[] } | { ok: false; reason: string }
export type Extractor = (bytes: Uint8Array, fileName: string) => Promise<Extracted>
/** What the image box said about a picture, or why it could not (engine/vision); handed to extractFile for IMAGE_EXTS. */
export type LookInput = { look: import('../../vision/lookClient.js').Look } | { failure: string }
