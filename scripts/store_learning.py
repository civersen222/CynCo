#!/usr/bin/env python3
"""Store a learning in archival memory.

Usage: python store_learning.py --session-id <id> --type <TYPE> --content <text> [options]
"""
import argparse
import json
import os
import sys
import uuid

def get_db_url():
    return os.environ.get('DATABASE_URL', 'postgresql://localcode:localcode_dev@localhost:5433/localcode')

def store(session_id: str, learning_type: str, content: str,
          context: str = '', tags: list[str] = None, confidence: str = 'medium'):
    import psycopg
    from embed import embed

    embedding = embed(content)
    db_url = get_db_url()

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO archival_memory (id, session_id, type, content, context, tags, confidence, embedding)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
            """, (
                str(uuid.uuid4()),
                session_id,
                learning_type,
                content,
                context,
                tags or [],
                confidence,
                json.dumps(embedding),
            ))
        conn.commit()
    print(f"Stored learning: {learning_type}", file=sys.stderr)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Store a learning in archival memory')
    parser.add_argument('--session-id', required=True)
    parser.add_argument('--type', required=True, choices=[
        'WORKING_SOLUTION', 'FAILED_APPROACH', 'ARCHITECTURAL_DECISION',
        'CODEBASE_PATTERN', 'ERROR_FIX', 'USER_PREFERENCE', 'OPEN_THREAD',
    ])
    parser.add_argument('--content', required=True)
    parser.add_argument('--context', default='')
    parser.add_argument('--tags', default='')
    parser.add_argument('--confidence', default='medium', choices=['high', 'medium', 'low'])
    args = parser.parse_args()

    tags = [t.strip() for t in args.tags.split(',') if t.strip()] if args.tags else []
    store(args.session_id, args.type, args.content, args.context, tags, args.confidence)
