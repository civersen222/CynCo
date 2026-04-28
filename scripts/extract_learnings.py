#!/usr/bin/env python3
"""Extract learnings from a conversation transcript.

Usage: python extract_learnings.py --session-id <id> --transcript <path>
       echo "transcript text" | python extract_learnings.py --session-id <id> --stdin

This is run as a post-session hook. It scans conversation text for patterns
that indicate learnings (solutions found, approaches abandoned, decisions made)
and stores them via store_learning.py.
"""
import argparse
import json
import os
import re
import sys

def extract_candidates(text: str) -> list[dict]:
    """Simple pattern-based extraction of learning candidates."""
    candidates = []

    # Pattern: "the fix was..." / "the solution is..."
    solution_patterns = [
        r'(?:the (?:fix|solution|answer|trick) (?:was|is)[:\s]+)(.{20,200})',
        r'(?:this works because[:\s]+)(.{20,200})',
        r'(?:fixed by[:\s]+)(.{20,200})',
    ]
    for pattern in solution_patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            candidates.append({
                'type': 'WORKING_SOLUTION',
                'content': match.group(1).strip(),
                'confidence': 'medium',
            })

    # Pattern: "didn't work" / "failed because"
    failure_patterns = [
        r'(?:(?:this |that |it )?(?:didn\'t work|failed|doesn\'t work)[:\s]+)(.{20,200})',
        r'(?:don\'t use[:\s]+)(.{20,200})',
    ]
    for pattern in failure_patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            candidates.append({
                'type': 'FAILED_APPROACH',
                'content': match.group(1).strip(),
                'confidence': 'medium',
            })

    # Pattern: "decided to..." / "we chose..."
    decision_patterns = [
        r'(?:decided to[:\s]+)(.{20,200})',
        r'(?:we chose[:\s]+)(.{20,200})',
    ]
    for pattern in decision_patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            candidates.append({
                'type': 'ARCHITECTURAL_DECISION',
                'content': match.group(1).strip(),
                'confidence': 'low',
            })

    return candidates

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--session-id', required=True)
    parser.add_argument('--transcript', help='Path to transcript file')
    parser.add_argument('--stdin', action='store_true')
    args = parser.parse_args()

    if args.stdin:
        text = sys.stdin.read()
    elif args.transcript:
        with open(args.transcript) as f:
            text = f.read()
    else:
        print("Provide --transcript <path> or --stdin", file=sys.stderr)
        sys.exit(1)

    candidates = extract_candidates(text)
    print(f"Found {len(candidates)} learning candidates", file=sys.stderr)

    # Store each candidate
    from store_learning import store
    for c in candidates:
        try:
            store(args.session_id, c['type'], c['content'], confidence=c['confidence'])
        except Exception as e:
            print(f"Failed to store learning: {e}", file=sys.stderr)
