# PASA Benchmark -- Paper 1: Governance-Aware Vector Subscriptions

Reproducibility archive for the evaluation in Johnson (2026),
"Governance-Aware Vector Subscriptions for Agent Knowledge Bases."

arXiv submission: 2026-03-21 (submit/7391096, cs.AI + cs.MA).

## Repository State

- **Git commit (benchmark run):** `6dde3b0` (2026-03-20)
- **Git commit (arXiv submission):** `2c033f5` (2026-03-21)
- **Git tag:** `paper1-arxiv-v1`
- **No code changes** between benchmark run and submission (only docs/terms added).

To restore the exact codebase:

```bash
git checkout paper1-arxiv-v1
```

## What Was Measured

Two benchmark scripts, both using synthetic data generated at runtime:

| Script | Evaluates | Paper Tables |
|--------|-----------|--------------|
| `pasa.js` (v1) | Precision/recall, policy compliance, latency, scalability, adversarial | Tables 2, 3, 6 |
| `pasa-v2.js` (v2) | Policy dimension ablation, curation guarantee | Tables 4, 5 |

## Configuration

| Parameter | Value |
|-----------|-------|
| Chunks | 1,000 synthetic |
| Agents | 50 |
| Domains | medical, financial, ai_safety, climate, cybersecurity |
| Sensitivity levels | 1-5 |
| Similarity threshold | 0.7 |
| Embedding model | bge-m3 (BAAI, 1024-dim) |
| Embedding source | Ollama (local, `http://172.18.0.1:11434`) |
| Subscriptions | 93 (auto-generated) |
| Scalability tiers | 10, 50, 100, 500 subscriptions |
| Ablation sample | 200 chunks |
| Curation sample | 200 chunks |
| Run date | 2026-03-20 |

## How to Reproduce

Prerequisites: running AIngram container with Ollama available.

```bash
# From host (test container)
docker exec aingram-api-test node benchmarks/pasa.js
docker exec aingram-api-test node benchmarks/pasa-v2.js
```

Results are written to stdout and saved to `benchmarks/pasa-results.json`
and `benchmarks/pasa-v2-results.json` respectively.

Data is synthetic and generated deterministically by the scripts (no external
dataset required). Embedding vectors depend on the Ollama model version --
use bge-m3 for exact reproduction.

## Files in This Archive

```
benchmarks/paper1/
  README.md                 # This file
  config.json               # Exact parameters used
  pasa-v1-results.json      # Raw output from pasa.js (Tables 2, 3, 6)
  pasa-v2-results.json      # Raw output from pasa-v2.js (Tables 4, 5)
  results-summary.md        # Human-readable summary matching paper tables
```

Benchmark source code: `benchmarks/pasa.js` and `benchmarks/pasa-v2.js` (same directory level).
