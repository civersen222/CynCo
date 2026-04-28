#!/usr/bin/env python3
"""Search archival memory using hybrid RRF (Reciprocal Rank Fusion).

Usage: python recall.py --query "search terms" [--k 5] [--text-only] [--vector-only]
"""
import argparse
import json
import os
import sys

def get_db_url():
    return os.environ.get('DATABASE_URL', 'postgresql://localcode:localcode_dev@localhost:5433/localcode')

def text_search(cur, query: str, k: int) -> list[dict]:
    cur.execute("""
        SELECT id, session_id, type, content, context, tags, confidence,
               ts_rank(to_tsvector('english', content || ' ' || COALESCE(context, '')),
                       plainto_tsquery('english', %s)) AS score
        FROM archival_memory
        WHERE to_tsvector('english', content || ' ' || COALESCE(context, ''))
              @@ plainto_tsquery('english', %s)
        ORDER BY score DESC
        LIMIT %s
    """, (query, query, k * 2))
    return [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]

def vector_search(cur, embedding: list[float], k: int) -> list[dict]:
    cur.execute("""
        SELECT id, session_id, type, content, context, tags, confidence,
               1 - (embedding <=> %s::vector) AS score
        FROM archival_memory
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> %s::vector
        LIMIT %s
    """, (json.dumps(embedding), json.dumps(embedding), k * 2))
    return [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]

def hybrid_rrf(text_results: list[dict], vector_results: list[dict], k: int = 60) -> list[dict]:
    """Reciprocal Rank Fusion: combine text and vector rankings."""
    scores: dict[str, float] = {}
    items: dict[str, dict] = {}

    for rank, item in enumerate(text_results):
        doc_id = item['id']
        scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (k + rank + 1)
        items[doc_id] = item

    for rank, item in enumerate(vector_results):
        doc_id = item['id']
        scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (k + rank + 1)
        items[doc_id] = item

    sorted_ids = sorted(scores, key=lambda x: scores[x], reverse=True)
    return [{'rrf_score': scores[did], **items[did]} for did in sorted_ids]

def recall(query: str, k: int = 5, mode: str = 'hybrid') -> list[dict]:
    import psycopg

    db_url = get_db_url()
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            if mode == 'text':
                return text_search(cur, query, k)[:k]
            elif mode == 'vector':
                from embed import embed
                embedding = embed(query)
                return vector_search(cur, embedding, k)[:k]
            else:  # hybrid
                text_results = text_search(cur, query, k)
                from embed import embed
                embedding = embed(query)
                vec_results = vector_search(cur, embedding, k)
                return hybrid_rrf(text_results, vec_results)[:k]

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Search archival memory')
    parser.add_argument('--query', required=True)
    parser.add_argument('--k', type=int, default=5)
    parser.add_argument('--text-only', action='store_true')
    parser.add_argument('--vector-only', action='store_true')
    args = parser.parse_args()

    mode = 'text' if args.text_only else ('vector' if args.vector_only else 'hybrid')
    results = recall(args.query, args.k, mode)
    json.dump(results, sys.stdout, indent=2, default=str)
    print()
