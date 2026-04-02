#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Paper 3 Evaluation Suite ==="
echo ""

# Install deps
pip install -r requirements.txt -q

# Track 1: Synthetic simulation
echo "--- Track 1: Synthetic ABM Simulation ---"
echo "[1/2] Moderate adversity..."
python simulation.py --config config.json --output results/ --seeds 10
echo "[2/2] High adversity (stress test)..."
python simulation.py --config config_stress.json --output results_stress/ --seeds 10

# Track 2: Community Notes replay
echo ""
echo "--- Track 2: Community Notes Replay ---"
cd community_notes
python replay_stratified.py

echo ""
echo "=== All done. Results in results/, results_stress/, community_notes/ ==="
