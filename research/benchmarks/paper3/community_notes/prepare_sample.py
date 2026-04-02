#!/usr/bin/env python3
"""
Prepare a balanced sample of Community Notes data for the Paper 3 benchmark.

Steps:
1. Read noteStatusHistory → filter to HELPFUL/NOT_HELPFUL
2. Sample 1000 of each (balanced)
3. Extract matching notes from notes.tsv
4. Stream ratings files to extract only matching ratings
5. Save sample as JSON for simulation consumption
"""

import csv
import json
import random
import sys
import os
import zipfile
from collections import defaultdict

SEED = 42
SAMPLE_PER_CLASS = 1000  # 1000 helpful + 1000 not helpful
MIN_RATINGS_PER_NOTE = 5  # Only keep notes with enough ratings

DATA_DIR = os.path.dirname(os.path.abspath(__file__))


def load_note_statuses():
    """Load noteStatusHistory and filter to decided notes."""
    print("Loading noteStatusHistory...")
    helpful = []
    not_helpful = []

    path = os.path.join(DATA_DIR, "noteStatusHistory-00000.tsv")
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            status = row.get("currentStatus", "")
            note_id = row.get("noteId", "")
            if status == "CURRENTLY_RATED_HELPFUL":
                helpful.append(note_id)
            elif status == "CURRENTLY_RATED_NOT_HELPFUL":
                not_helpful.append(note_id)

    print(f"  Helpful: {len(helpful)}, Not helpful: {len(not_helpful)}")
    return helpful, not_helpful


def sample_notes(helpful, not_helpful, rng):
    """Balanced random sample."""
    rng.shuffle(helpful)
    rng.shuffle(not_helpful)

    sampled_helpful = helpful[:SAMPLE_PER_CLASS]
    sampled_not_helpful = not_helpful[:SAMPLE_PER_CLASS]

    note_ids = set(sampled_helpful + sampled_not_helpful)
    labels = {}
    for nid in sampled_helpful:
        labels[nid] = "HELPFUL"
    for nid in sampled_not_helpful:
        labels[nid] = "NOT_HELPFUL"

    print(f"  Sampled: {len(sampled_helpful)} helpful + {len(sampled_not_helpful)} not helpful = {len(note_ids)}")
    return note_ids, labels


def load_notes_metadata(note_ids):
    """Load note metadata for sampled notes from notes.zip."""
    print("Loading notes metadata from zip...")
    notes = {}

    zip_path = os.path.join(DATA_DIR, "notes.zip")
    with zipfile.ZipFile(zip_path, "r") as zf:
        for name in zf.namelist():
            if not name.endswith(".tsv"):
                continue
            print(f"  Reading {name}...")
            with zf.open(name) as f:
                import io
                text_f = io.TextIOWrapper(f, encoding="utf-8")
                reader = csv.DictReader(text_f, delimiter="\t")
                for row in reader:
                    nid = row.get("noteId", "")
                    if nid in note_ids:
                        notes[nid] = {
                            "noteId": nid,
                            "classification": row.get("classification", ""),
                            "createdAtMillis": row.get("createdAtMillis", ""),
                            "summary": row.get("summary", "")[:200],  # Truncate for size
                        }

    print(f"  Found metadata for {len(notes)}/{len(note_ids)} notes")
    return notes


def stream_ratings(note_ids):
    """Stream ratings from zip, keeping only those for sampled notes."""
    print("Streaming ratings from zip (this may take a while)...")
    ratings = defaultdict(list)
    total_read = 0
    matched = 0

    # Check which rating files exist
    for chunk_num in range(20):  # Usually 0-19
        zip_name = f"ratings-{chunk_num:05d}.zip"
        zip_path = os.path.join(DATA_DIR, zip_name)

        if not os.path.exists(zip_path):
            # Try to download
            url = f"https://ton.twimg.com/birdwatch-public-data/2026/03/21/noteRatings/{zip_name}"
            print(f"  Downloading {zip_name}...")
            ret = os.system(f'curl -sL -o "{zip_path}" "{url}" 2>/dev/null')

            # Check if download worked (file should be > 1KB)
            if not os.path.exists(zip_path) or os.path.getsize(zip_path) < 1000:
                if os.path.exists(zip_path):
                    os.remove(zip_path)
                print(f"  {zip_name} not available, stopping at chunk {chunk_num}")
                break

        print(f"  Processing {zip_name}...")
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                for name in zf.namelist():
                    if not name.endswith(".tsv"):
                        continue
                    import io
                    with zf.open(name) as f:
                        text_f = io.TextIOWrapper(f, encoding="utf-8")
                        reader = csv.DictReader(text_f, delimiter="\t")
                        for row in reader:
                            total_read += 1
                            nid = row.get("noteId", "")
                            if nid in note_ids:
                                matched += 1
                                ratings[nid].append({
                                    "participantId": row.get("participantId", ""),
                                    "helpfulnessLevel": row.get("helpfulnessLevel", ""),
                                    "createdAtMillis": row.get("createdAtMillis", ""),
                                })
                            if total_read % 5_000_000 == 0:
                                print(f"    ... {total_read:,} ratings read, {matched:,} matched")
        except Exception as e:
            print(f"  Error processing {zip_name}: {e}")
            continue

        # Clean up downloaded rating file to save space
        if chunk_num > 0:  # Keep first chunk as reference
            os.remove(zip_path)
            print(f"  Cleaned up {zip_name}")

        # If we have enough ratings, stop early
        notes_with_ratings = sum(1 for nid in note_ids if len(ratings.get(nid, [])) >= MIN_RATINGS_PER_NOTE)
        print(f"  Notes with >= {MIN_RATINGS_PER_NOTE} ratings: {notes_with_ratings}/{len(note_ids)}")
        if notes_with_ratings >= len(note_ids) * 0.8:
            print(f"  80%+ coverage reached, stopping early")
            break

    print(f"  Total ratings read: {total_read:,}, matched: {matched:,}")
    return dict(ratings)


def build_sample(note_ids, labels, notes_meta, ratings):
    """Build final sample, filtering notes with too few ratings."""
    sample = []
    skipped = 0

    for nid in note_ids:
        note_ratings = ratings.get(nid, [])
        if len(note_ratings) < MIN_RATINGS_PER_NOTE:
            skipped += 1
            continue

        # Map ratings to votes
        votes = []
        for r in note_ratings:
            level = r.get("helpfulnessLevel", "")
            if level == "HELPFUL":
                vote = 1
            elif level == "NOT_HELPFUL":
                vote = -1
            elif level == "SOMEWHAT_HELPFUL":
                vote = 0
            else:
                vote = 0

            votes.append({
                "participantId": r["participantId"],
                "vote": vote,
                "helpfulnessLevel": level,
                "createdAtMillis": r.get("createdAtMillis", ""),
            })

        # Sort votes by timestamp (chronological replay)
        votes.sort(key=lambda v: v.get("createdAtMillis", "0"))

        sample.append({
            "noteId": nid,
            "label": labels[nid],  # HELPFUL or NOT_HELPFUL (ground truth)
            "classification": notes_meta.get(nid, {}).get("classification", ""),
            "summary": notes_meta.get(nid, {}).get("summary", ""),
            "n_ratings": len(votes),
            "votes": votes,
        })

    print(f"\nFinal sample: {len(sample)} notes ({skipped} skipped for insufficient ratings)")
    print(f"  Helpful: {sum(1 for s in sample if s['label'] == 'HELPFUL')}")
    print(f"  Not helpful: {sum(1 for s in sample if s['label'] == 'NOT_HELPFUL')}")
    print(f"  Avg ratings/note: {sum(s['n_ratings'] for s in sample) / max(len(sample), 1):.1f}")

    return sample


def main():
    rng = random.Random(SEED)

    # Step 1: Load statuses
    helpful, not_helpful = load_note_statuses()

    # Step 2: Sample
    note_ids, labels = sample_notes(helpful, not_helpful, rng)

    # Step 3: Load note metadata
    notes_meta = load_notes_metadata(note_ids)

    # Step 4: Stream ratings
    ratings = stream_ratings(note_ids)

    # Step 5: Build and save sample
    sample = build_sample(note_ids, labels, notes_meta, ratings)

    output_path = os.path.join(DATA_DIR, "sample.json")
    with open(output_path, "w") as f:
        json.dump(sample, f, indent=2)

    print(f"\nSaved to {output_path} ({os.path.getsize(output_path) / 1024 / 1024:.1f} MB)")

    # Save stats
    stats = {
        "total_notes_in_dataset": len(helpful) + len(not_helpful),
        "sampled_notes": len(sample),
        "helpful": sum(1 for s in sample if s["label"] == "HELPFUL"),
        "not_helpful": sum(1 for s in sample if s["label"] == "NOT_HELPFUL"),
        "avg_ratings_per_note": sum(s["n_ratings"] for s in sample) / max(len(sample), 1),
        "min_ratings_per_note": min((s["n_ratings"] for s in sample), default=0),
        "max_ratings_per_note": max((s["n_ratings"] for s in sample), default=0),
        "total_votes": sum(s["n_ratings"] for s in sample),
    }

    stats_path = os.path.join(DATA_DIR, "sample_stats.json")
    with open(stats_path, "w") as f:
        json.dump(stats, f, indent=2)

    print(f"Stats saved to {stats_path}")
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
