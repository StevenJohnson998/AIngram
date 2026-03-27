"""
Metrics and plotting for the Deliberative Curation Protocol simulation.

Implements 8 metrics:
1. Precision: fraction of active chunks that are truly good (q >= 0.7)
2. Recall: fraction of truly good chunks that are active
3. Convergence time: rounds until reputation ranking stabilizes
4. Sybil resistance: precision ratio with/without Sybil injection
5. Sycophancy impact: delta precision when sycophant % changes
6. Fairness (Gini): Gini coefficient of reputation distribution
7. Sanction FPR: false positive rate of sanctions on honest/broken agents
8. Throughput: chunks reaching terminal state per round
"""

import numpy as np
import json
import os
from typing import Dict, List, Optional, Tuple
from src.protocol import ChunkState, TERMINAL_STATES, DECIDED_STATES


def compute_precision(chunks: list) -> float:
    """
    Precision = |{c: active AND q>=0.7}| / |{c: active}|
    How many active chunks are actually good.
    """
    active = [c for c in chunks if c.state == ChunkState.ACTIVE]
    if not active:
        return 0.0
    good_active = sum(1 for c in active if c.quality >= 0.7)
    return good_active / len(active)


def compute_recall(chunks: list) -> float:
    """
    Recall = |{c: active AND q>=0.7}| / |{c: q>=0.7}|
    How many truly good chunks made it to active.
    """
    all_good = [c for c in chunks if c.quality >= 0.7]
    if not all_good:
        return 0.0
    good_active = sum(1 for c in all_good if c.state == ChunkState.ACTIVE)
    return good_active / len(all_good)


def compute_gini(values: List[float]) -> float:
    """
    Compute Gini coefficient of a distribution.
    0 = perfect equality, 1 = maximum inequality.
    """
    if not values or len(values) < 2:
        return 0.0
    arr = np.array(sorted(values))
    n = len(arr)
    if arr.sum() == 0:
        return 0.0
    index = np.arange(1, n + 1)
    return (2 * np.sum(index * arr) - (n + 1) * np.sum(arr)) / (n * np.sum(arr))


def compute_convergence_time(reputation_history: List[List[float]],
                             threshold: float = 0.01,
                             window: int = 10) -> int:
    """
    Convergence time: first round where Kendall tau correlation between
    consecutive reputation rankings stays above (1 - threshold) for
    `window` consecutive rounds.

    Uses a simplified rank stability metric instead of scipy's kendalltau
    to avoid issues with constant arrays.
    """
    if len(reputation_history) < window + 1:
        return len(reputation_history)

    stable_count = 0
    for i in range(1, len(reputation_history)):
        prev_rank = np.argsort(np.argsort(reputation_history[i - 1]))
        curr_rank = np.argsort(np.argsort(reputation_history[i]))

        # Normalized rank displacement
        n = len(prev_rank)
        if n == 0:
            continue
        displacement = np.sum(np.abs(prev_rank - curr_rank)) / (n * n)

        if displacement < threshold:
            stable_count += 1
            if stable_count >= window:
                return i - window + 1
        else:
            stable_count = 0

    return len(reputation_history)  # Never converged


def compute_sanction_fpr(agents: list, sanction_system, current_round: int) -> float:
    """
    Sanction False Positive Rate:
    |honest/broken agents at sigma >= 2| / |total honest/broken agents|

    Measures how often the system incorrectly sanctions non-malicious agents.
    """
    from src.agents import AgentType

    honest_broken = [a for a in agents
                     if a.agent_type in (AgentType.HONEST, AgentType.BROKEN)]
    if not honest_broken:
        return 0.0

    falsely_sanctioned = sum(
        1 for a in honest_broken
        if sanction_system.get_sanction_level(a.agent_id, current_round) >= 2
    )
    return falsely_sanctioned / len(honest_broken)


def compute_throughput(chunks: list, current_round: int) -> float:
    """Chunks reaching a decided state per round."""
    if current_round == 0:
        return 0.0
    decided = sum(1 for c in chunks if c.state in DECIDED_STATES)
    return decided / current_round


class MetricsTracker:
    """
    Tracks metrics over the course of a simulation run.
    Records per-round snapshots for time series analysis.
    """

    def __init__(self):
        self.precision_history: List[float] = []
        self.recall_history: List[float] = []
        self.gini_history: List[float] = []
        self.reputation_history: List[List[float]] = []
        self.throughput_history: List[float] = []
        self.sanction_fpr_history: List[float] = []

    def record_round(self, chunks: list, agents: list, reputation_system,
                     sanction_system, current_round: int):
        """Record all metrics for the current round."""
        self.precision_history.append(compute_precision(chunks))
        self.recall_history.append(compute_recall(chunks))

        rep_dist = reputation_system.get_reputation_distribution()
        self.reputation_history.append(rep_dist)
        self.gini_history.append(compute_gini(rep_dist))

        self.throughput_history.append(compute_throughput(chunks, current_round + 1))
        self.sanction_fpr_history.append(
            compute_sanction_fpr(agents, sanction_system, current_round)
        )

    def get_summary(self, chunks: list, agents: list, reputation_system,
                    sanction_system, current_round: int) -> Dict:
        """Compute final summary metrics."""
        return {
            "precision": compute_precision(chunks),
            "recall": compute_recall(chunks),
            "convergence_time": compute_convergence_time(self.reputation_history),
            "gini": compute_gini(reputation_system.get_reputation_distribution()),
            "sanction_fpr": compute_sanction_fpr(agents, sanction_system, current_round),
            "throughput": compute_throughput(chunks, current_round),
            "precision_history": self.precision_history,
            "recall_history": self.recall_history,
            "gini_history": self.gini_history,
            "throughput_history": self.throughput_history,
            "sanction_fpr_history": self.sanction_fpr_history,
        }


def save_results(results: Dict, output_dir: str, run_name: str):
    """Save results to JSON file."""
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, f"{run_name}.json")

    # Convert numpy types to Python types for JSON serialization
    def convert(obj):
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        elif isinstance(obj, dict):
            return {k: convert(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [convert(v) for v in obj]
        return obj

    with open(filepath, "w") as f:
        json.dump(convert(results), f, indent=2)
    return filepath


def generate_plots(all_results: Dict[str, Dict], output_dir: str):
    """
    Generate matplotlib plots:
    1. Precision over time (full protocol vs baselines)
    2. Reputation distribution (final state)
    3. Gini coefficient over time
    4. Ablation comparison bar chart
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    os.makedirs(output_dir, exist_ok=True)

    # Color scheme
    colors = {
        "full_protocol": "#2196F3",
        "majority_vote": "#FF9800",
        "single_curator": "#4CAF50",
        "ungoverned": "#F44336",
        "weighted_no_deliberation": "#9C27B0",
    }

    # 1. Precision over time
    fig, ax = plt.subplots(figsize=(10, 6))
    for name, results in all_results.items():
        if "precision_history" in results and name in colors:
            ax.plot(results["precision_history"], label=name.replace("_", " ").title(),
                    color=colors.get(name, None), alpha=0.8)
    ax.set_xlabel("Round")
    ax.set_ylabel("Precision")
    ax.set_title("Precision Over Time: Full Protocol vs Baselines")
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.set_ylim(0, 1.05)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "precision_over_time.png"), dpi=150)
    plt.close(fig)

    # 2. Final reputation distribution (full protocol only)
    if "full_protocol" in all_results:
        fig, ax = plt.subplots(figsize=(10, 6))
        rep_hist = all_results["full_protocol"].get("reputation_history", [])
        if rep_hist:
            final_rep = rep_hist[-1] if isinstance(rep_hist[-1], list) else rep_hist
            ax.hist(final_rep, bins=20, color="#2196F3", alpha=0.7, edgecolor="black")
            ax.set_xlabel("Reputation Score")
            ax.set_ylabel("Number of Agents")
            ax.set_title("Final Reputation Distribution (Full Protocol)")
            ax.grid(True, alpha=0.3)
            fig.tight_layout()
        fig.savefig(os.path.join(output_dir, "reputation_distribution.png"), dpi=150)
        plt.close(fig)

    # 3. Gini over time
    fig, ax = plt.subplots(figsize=(10, 6))
    for name, results in all_results.items():
        if "gini_history" in results and name in colors:
            ax.plot(results["gini_history"], label=name.replace("_", " ").title(),
                    color=colors.get(name, None), alpha=0.8)
    ax.set_xlabel("Round")
    ax.set_ylabel("Gini Coefficient")
    ax.set_title("Reputation Inequality Over Time")
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.set_ylim(0, 1.0)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "gini_over_time.png"), dpi=150)
    plt.close(fig)

    # 4. Ablation comparison bar chart
    ablation_names = [
        "no_reputation", "no_sanctions", "no_deliberation", "no_decay",
        "no_broken_handling", "no_sycophancy_defense", "no_farming_cap",
        "no_dispute_limit"
    ]

    fig, ax = plt.subplots(figsize=(12, 6))
    names = ["full_protocol"] + [a for a in ablation_names if a in all_results]
    precisions = []
    for name in names:
        if name in all_results:
            precisions.append(all_results[name].get("precision", 0))
        else:
            precisions.append(0)

    x = np.arange(len(names))
    bars = ax.bar(x, precisions, color=["#2196F3"] + ["#90CAF9"] * (len(names) - 1),
                  edgecolor="black", alpha=0.8)

    # Highlight full protocol bar
    if len(bars) > 0:
        bars[0].set_color("#2196F3")

    ax.set_xticks(x)
    ax.set_xticklabels([n.replace("_", "\n") for n in names], fontsize=8)
    ax.set_ylabel("Final Precision")
    ax.set_title("Ablation Study: Impact of Protocol Components")
    ax.grid(True, alpha=0.3, axis="y")
    ax.set_ylim(0, 1.05)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "ablation_comparison.png"), dpi=150)
    plt.close(fig)

    # 5. Combined metrics summary
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))

    # Precision
    ax = axes[0, 0]
    for name in ["full_protocol", "majority_vote", "ungoverned"]:
        if name in all_results and "precision_history" in all_results[name]:
            ax.plot(all_results[name]["precision_history"],
                    label=name.replace("_", " ").title(),
                    color=colors.get(name, None), alpha=0.8)
    ax.set_title("Precision")
    ax.set_xlabel("Round")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # Recall
    ax = axes[0, 1]
    for name in ["full_protocol", "majority_vote", "ungoverned"]:
        if name in all_results and "recall_history" in all_results[name]:
            ax.plot(all_results[name]["recall_history"],
                    label=name.replace("_", " ").title(),
                    color=colors.get(name, None), alpha=0.8)
    ax.set_title("Recall")
    ax.set_xlabel("Round")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # Throughput
    ax = axes[1, 0]
    for name in ["full_protocol", "majority_vote", "ungoverned"]:
        if name in all_results and "throughput_history" in all_results[name]:
            ax.plot(all_results[name]["throughput_history"],
                    label=name.replace("_", " ").title(),
                    color=colors.get(name, None), alpha=0.8)
    ax.set_title("Throughput (chunks/round)")
    ax.set_xlabel("Round")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # Sanction FPR
    ax = axes[1, 1]
    if "full_protocol" in all_results and "sanction_fpr_history" in all_results["full_protocol"]:
        ax.plot(all_results["full_protocol"]["sanction_fpr_history"],
                label="Full Protocol", color="#2196F3", alpha=0.8)
    ax.set_title("Sanction False Positive Rate")
    ax.set_xlabel("Round")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    fig.suptitle("Deliberative Curation Protocol - Summary", fontsize=14)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "summary.png"), dpi=150)
    plt.close(fig)
