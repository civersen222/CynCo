#!/usr/bin/env python3
"""Generate BGE embeddings for text.

Usage: python embed.py "text to embed"
       echo "text" | python embed.py --stdin
Output: JSON array of floats (384-dim for BGE-small, 1024-dim for BGE-large)
"""
import sys
import json
import os

def get_model_name():
    return os.environ.get('LOCALCODE_EMBED_MODEL', 'BAAI/bge-small-en-v1.5')

def embed(text: str) -> list[float]:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(get_model_name())
    embedding = model.encode(text, normalize_embeddings=True)
    return embedding.tolist()

if __name__ == '__main__':
    if '--stdin' in sys.argv:
        text = sys.stdin.read().strip()
    elif len(sys.argv) > 1 and sys.argv[1] != '--stdin':
        text = sys.argv[1]
    else:
        print("Usage: embed.py <text> or echo text | embed.py --stdin", file=sys.stderr)
        sys.exit(1)

    result = embed(text)
    json.dump(result, sys.stdout)
    print()
