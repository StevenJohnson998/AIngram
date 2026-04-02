# Paper 3: Deliberative Curation Protocol - Evaluation Suite

Evaluation code for "Deliberative Curation: A Formal Consensus Protocol for Multi-Agent Knowledge Bases".

Two evaluation tracks: synthetic ABM simulation and Community Notes replay benchmark.

## Quick start

```bash
pip install -r requirements.txt

# 1. Synthetic simulation (7 archetypes, 2 adversity scenarios)
python simulation.py --config config.json --output results/ --seeds 10
python simulation.py --config config_stress.json --output results_stress/ --seeds 10

# 2. Community Notes replay (1670 real notes, stratified analysis)
cd community_notes
python replay_stratified.py
```

## Structure

```
benchmarks/paper3/
├── simulation.py              # Main ABM simulation runner
├── config.json                # Moderate adversity parameters
├── config_stress.json         # High adversity parameters
├── src/                       # Simulation modules
│   ├── protocol.py            # LTS chunk lifecycle, voting
│   ├── reputation.py          # Beta Reputation + EigenTrust
│   ├── agents.py              # 7 archetypes
│   ├── sanctions.py           # Graduated sanctions, broken detection
│   └── metrics.py             # 8 metrics + plots
├── community_notes/           # Real-data benchmark
│   ├── README.md              # Detailed CN benchmark docs
│   ├── prepare_sample.py      # Download + sample CN data
│   ├── replay_benchmark.py    # Full replay with disagreement analysis
│   ├── replay_stratified.py   # Stratified analysis (main script)
│   ├── sample.json            # 1670 notes, 202K ratings (pre-sampled)
│   └── stratified_results.json
├── results/                   # Synthetic simulation outputs
└── results_stress/            # Stress scenario outputs
```

## Synthetic simulation

100 agents, 7 archetypes (honest, lazy, malicious, broken, strategic, sycophant, adaptive), 1000 chunks, 500 rounds.

**Reputation model**: consensus-based noisy feedback (15% noise rate) instead of ground-truth oracle. Retraction signal for delayed corrections.

**Configurations**: full_protocol + 4 baselines + 8 ablations = 13 runs per scenario.

## Community Notes replay

Replays 1670 real Community Notes ratings (202K total) through the protocol. Compares protocol decisions with CN bridging algorithm decisions, stratified by rating density.

**Key finding**: Protocol adds most value on sparse-signal notes (5-15 ratings: 99.5% vs 98.0% majority, precision 1.000). On dense notes (200+), simple majority suffices.

## Dependencies

- numpy >= 1.24
- matplotlib >= 3.7
- scipy >= 1.10
