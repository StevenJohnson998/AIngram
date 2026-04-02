# Community Notes Replay Benchmark

Replays real Community Notes ratings through the deliberative curation protocol and compares decisions.

## Data

**Source**: [X Community Notes public data](https://communitynotes.x.com/guide/en/under-the-hood/download-data) (2026-03-21 snapshot).

**Sample**: 1670 notes (824 helpful, 846 not helpful) with 202,315 ratings. Balanced sample from 345,437 decided notes. Minimum 5 ratings per note.

The `sample.json` file contains all notes and ratings ready for replay. To regenerate from raw data, see `prepare_sample.py`.

## Quick start

```bash
# Run the main benchmark (3 configs: ungoverned, majority vote, our protocol)
python replay_stratified.py

# Run the detailed benchmark with disagreement analysis
python replay_benchmark.py
```

Requires Python 3.10+ with numpy. Uses the simulation's reputation system from `../src/`.

## Scripts

| Script | Purpose |
|---|---|
| `prepare_sample.py` | Downloads and samples Community Notes data. Only needed to regenerate `sample.json`. Downloads ~8 GB of rating chunks (cleaned up after). |
| `replay_benchmark.py` | Replays ratings through 3 configurations, reports agreement with CN decisions, disagreement analysis. |
| `replay_stratified.py` | Same replay but stratified by rating density (sparse/moderate/dense/very dense). This is the main analysis script. |

## Key finding

The protocol's value is strongest on sparse-signal notes (5-15 ratings):

| Rating density | Ungoverned | Majority Vote | Our Protocol |
|---|---|---|---|
| Sparse (5-15) | 8.1% | 98.0% | **99.5%** |
| Moderate (16-50) | 38.1% | 99.0% | **99.6%** |
| Dense (51-200) | 61.9% | 99.7% | 99.3% |
| Very dense (200+) | 70.3% | 98.2% | 95.0% |

Reputation weighting improves decisions when signal is scarce. On dense notes (many raters), simple majority suffices and the protocol's conservatism slightly hurts.

## Data schema

Each entry in `sample.json`:

```json
{
  "noteId": "...",
  "label": "HELPFUL" | "NOT_HELPFUL",
  "classification": "...",
  "summary": "...",
  "n_ratings": 42,
  "votes": [
    {
      "participantId": "...",
      "vote": 1,
      "helpfulnessLevel": "HELPFUL",
      "createdAtMillis": "..."
    }
  ]
}
```

Vote mapping: HELPFUL -> +1, NOT_HELPFUL -> -1, SOMEWHAT_HELPFUL -> 0.
