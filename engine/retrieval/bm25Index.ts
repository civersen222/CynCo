const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

interface DocData {
  termFreqs: Map<string, number>;
  length: number;
}

export class BM25Index {
  private docs = new Map<number, DocData>();
  private df = new Map<string, number>(); // document frequency per term
  private totalLength = 0;

  add(docId: number, text: string): void {
    // Remove existing doc first if re-adding
    if (this.docs.has(docId)) {
      this.remove(docId);
    }

    const tokens = tokenize(text);
    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    }

    // Update document frequencies
    for (const term of termFreqs.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }

    this.docs.set(docId, { termFreqs, length: tokens.length });
    this.totalLength += tokens.length;
  }

  remove(docId: number): void {
    const doc = this.docs.get(docId);
    if (!doc) return;

    for (const term of doc.termFreqs.keys()) {
      const prev = this.df.get(term) ?? 0;
      if (prev <= 1) {
        this.df.delete(term);
      } else {
        this.df.set(term, prev - 1);
      }
    }

    this.totalLength -= doc.length;
    this.docs.delete(docId);
  }

  search(query: string, topK: number): { docId: number; score: number }[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docs.size === 0) return [];

    const N = this.docs.size;
    const avgDl = this.totalLength / N;

    const scores = new Map<number, number>();

    for (const term of terms) {
      const df = this.df.get(term) ?? 0;
      if (df === 0) continue;

      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const [docId, doc] of this.docs) {
        const tf = doc.termFreqs.get(term) ?? 0;
        if (tf === 0) continue;

        const dl = doc.length;
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgDl)));
        const contribution = idf * tfNorm;

        scores.set(docId, (scores.get(docId) ?? 0) + contribution);
      }
    }

    return Array.from(scores.entries())
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
