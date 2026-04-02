#!/usr/bin/env python3
"""
Community Notes Replay Benchmark for Paper 3.

Replays real Community Notes ratings through our deliberative curation protocol
and compares the protocol's decisions with Community Notes' actual decisions.

Key comparison: Human deliberation (CN bridging algorithm) vs Agent protocol.
"""

import json
import os
import sys
import numpy as np
from collections import defaultdict

# Add parent src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from reputation import ReputationSystem
from protocol import Protocol, ChunkState

DATA_DIR = os.path.dirname(os.path.abspath(__file__))


def load_sample():
    """Load the prepared Community Notes sample."""
    with open(os.path.join(DATA_DIR, "sample.json"), "r") as f:
        return json.load(f)


def replay_majority_vote(sample):
    """Baseline: simple majority vote (no reputation, no protocol)."""
    results = {"tp": 0, "fp": 0, "tn": 0, "fn": 0}

    for note in sample:
        votes = [v["vote"] for v in note["votes"]]
        pos = sum(1 for v in votes if v == 1)
        neg = sum(1 for v in votes if v == -1)

        # Majority decides
        predicted_helpful = pos > neg
        actual_helpful = note["label"] == "HELPFUL"

        if predicted_helpful and actual_helpful:
            results["tp"] += 1
        elif predicted_helpful and not actual_helpful:
            results["fp"] += 1
        elif not predicted_helpful and actual_helpful:
            results["fn"] += 1
        else:
            results["tn"] += 1

    return results


def replay_weighted_vote(sample, config):
    """Our protocol: reputation-weighted voting with consensus feedback."""
    rng = np.random.default_rng(42)
    rep_config = config["reputation"]
    voting_config = config["voting"]

    # Build participant registry
    all_participants = set()
    for note in sample:
        for v in note["votes"]:
            all_participants.add(v["participantId"])

    participant_list = sorted(all_participants)
    pid_to_idx = {pid: i for i, pid in enumerate(participant_list)}
    n_participants = len(participant_list)

    # Initialize reputation system
    # Need sanctions config for farming_window
    full_config = {"reputation": rep_config, "sanctions": config.get("sanctions", {"window": 100})}
    rep_system = ReputationSystem(config=full_config, rng=rng)

    # Initialize all participants
    for pid, idx in pid_to_idx.items():
        rep_system.init_agent(idx)

    results = {"tp": 0, "fp": 0, "tn": 0, "fn": 0}
    decisions = []

    # Sort notes by first rating timestamp (chronological replay)
    sorted_sample = sorted(sample, key=lambda n: min(
        (v.get("createdAtMillis", "0") for v in n["votes"]),
        default="0"
    ))

    for round_idx, note in enumerate(sorted_sample):
        votes = note["votes"]
        actual_helpful = note["label"] == "HELPFUL"

        # Compute weighted vote score
        total_weight = 0.0
        weighted_sum = 0.0
        voter_ids = []

        for v in votes:
            pid = v["participantId"]
            if pid not in pid_to_idx:
                continue
            aid = pid_to_idx[pid]
            vote_val = v["vote"]
            if vote_val == 0:
                continue

            w = rep_system.get_effective_weight(aid)
            weighted_sum += w * vote_val
            total_weight += w
            voter_ids.append((aid, vote_val))

        if total_weight == 0:
            score = 0.0
        else:
            score = weighted_sum / total_weight

        # Decision
        predicted_helpful = score >= voting_config["tau_accept"]

        if predicted_helpful and actual_helpful:
            results["tp"] += 1
        elif predicted_helpful and not actual_helpful:
            results["fp"] += 1
        elif not predicted_helpful and actual_helpful:
            results["fn"] += 1
        else:
            results["tn"] += 1

        # Update reputation based on consensus outcome (noisy, like our simulation)
        noise_rate = rep_config.get("reputation_noise", 0.15)
        for aid, vote_val in voter_ids:
            # Consensus-based: vote aligns with final decision
            if predicted_helpful:
                correct = (vote_val == 1)
            else:
                correct = (vote_val == -1)

            # Add noise
            if rng.random() < noise_rate:
                correct = not correct

            # Stronger signal for clear decisions
            if abs(score) > 0.5:
                amount = 1.0
            else:
                amount = 0.4

            rep_system.update_reputation(aid, positive=correct, current_round=round_idx, amount=amount)

        # Periodic EigenTrust update
        if round_idx % 50 == 49:
            rep_system.compute_eigentrust()

        decisions.append({
            "noteId": note["noteId"],
            "actual": note["label"],
            "predicted": "HELPFUL" if predicted_helpful else "NOT_HELPFUL",
            "score": round(score, 4),
            "n_voters": len(voter_ids),
            "correct": predicted_helpful == actual_helpful,
        })

    return results, decisions


def replay_weighted_no_sycophancy_defense(sample, config):
    """Ablation: weighted vote without commit-reveal (sycophants copy majority)."""
    rng = np.random.default_rng(42)
    rep_config = config["reputation"]
    voting_config = config["voting"]

    all_participants = set()
    for note in sample:
        for v in note["votes"]:
            all_participants.add(v["participantId"])

    participant_list = sorted(all_participants)
    pid_to_idx = {pid: i for i, pid in enumerate(participant_list)}
    n_participants = len(participant_list)

    full_config = {"reputation": rep_config, "sanctions": config.get("sanctions", {"window": 100})}
    rep_system = ReputationSystem(config=full_config, rng=rng)

    for pid, idx in pid_to_idx.items():
        rep_system.init_agent(idx)

    results = {"tp": 0, "fp": 0, "tn": 0, "fn": 0}

    sorted_sample = sorted(sample, key=lambda n: min(
        (v.get("createdAtMillis", "0") for v in n["votes"]),
        default="0"
    ))

    for round_idx, note in enumerate(sorted_sample):
        votes = note["votes"]
        actual_helpful = note["label"] == "HELPFUL"

        # Without commit-reveal: simulate sycophancy by amplifying early votes
        # First 30% of votes are independent, rest follow majority so far
        n_independent = max(3, int(len(votes) * 0.3))

        total_weight = 0.0
        weighted_sum = 0.0
        voter_ids = []
        running_sum = 0

        for i, v in enumerate(votes):
            pid = v["participantId"]
            if pid not in pid_to_idx:
                continue
            aid = pid_to_idx[pid]
            vote_val = v["vote"]
            if vote_val == 0:
                continue

            # After initial votes, 30% of voters copy the majority (sycophancy)
            if i >= n_independent and rng.random() < 0.30:
                vote_val = 1 if running_sum > 0 else -1

            w = rep_system.get_effective_weight(aid)
            weighted_sum += w * vote_val
            total_weight += w
            running_sum += vote_val
            voter_ids.append((aid, vote_val))

        if total_weight == 0:
            score = 0.0
        else:
            score = weighted_sum / total_weight

        predicted_helpful = score >= voting_config["tau_accept"]

        if predicted_helpful and actual_helpful:
            results["tp"] += 1
        elif predicted_helpful and not actual_helpful:
            results["fp"] += 1
        elif not predicted_helpful and actual_helpful:
            results["fn"] += 1
        else:
            results["tn"] += 1

        # Update reputation
        noise_rate = rep_config.get("reputation_noise", 0.15)
        for aid, vote_val in voter_ids:
            if predicted_helpful:
                correct = (vote_val == 1)
            else:
                correct = (vote_val == -1)
            if rng.random() < noise_rate:
                correct = not correct
            amount = 1.0 if abs(score) > 0.5 else 0.4
            rep_system.update_reputation(aid, positive=correct, current_round=round_idx, amount=amount)

        if round_idx % 50 == 49:
            rep_system.compute_eigentrust()

    return results


def compute_metrics(results, name):
    """Compute precision, recall, F1, accuracy from confusion matrix."""
    tp, fp, tn, fn = results["tp"], results["fp"], results["tn"], results["fn"]
    total = tp + fp + tn + fn

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    accuracy = (tp + tn) / total if total > 0 else 0
    agreement = accuracy  # Agreement with CN decisions

    return {
        "name": name,
        "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "accuracy": round(accuracy, 4),
        "agreement_with_cn": round(agreement, 4),
    }


def main():
    print("=" * 70)
    print("Community Notes Replay Benchmark")
    print("=" * 70)

    sample = load_sample()
    print(f"Loaded {len(sample)} notes ({sum(1 for s in sample if s['label'] == 'HELPFUL')} helpful, "
          f"{sum(1 for s in sample if s['label'] == 'NOT_HELPFUL')} not helpful)")
    print(f"Total ratings: {sum(s['n_ratings'] for s in sample):,}")

    # Load simulation config for protocol parameters
    config_path = os.path.join(DATA_DIR, "..", "config.json")
    with open(config_path) as f:
        config = json.load(f)

    print("\n--- Baseline: Simple Majority Vote ---")
    majority_results = replay_majority_vote(sample)
    majority_metrics = compute_metrics(majority_results, "Majority Vote")
    print(f"Agreement with CN: {majority_metrics['agreement_with_cn']:.1%}")
    print(f"Precision: {majority_metrics['precision']:.4f}, Recall: {majority_metrics['recall']:.4f}, F1: {majority_metrics['f1']:.4f}")

    print("\n--- Our Protocol: Reputation-Weighted Voting ---")
    weighted_results, decisions = replay_weighted_vote(sample, config)
    weighted_metrics = compute_metrics(weighted_results, "Reputation-Weighted (Our Protocol)")
    print(f"Agreement with CN: {weighted_metrics['agreement_with_cn']:.1%}")
    print(f"Precision: {weighted_metrics['precision']:.4f}, Recall: {weighted_metrics['recall']:.4f}, F1: {weighted_metrics['f1']:.4f}")

    print("\n--- Ablation: Without Sycophancy Defense ---")
    no_syc_results = replay_weighted_no_sycophancy_defense(sample, config)
    no_syc_metrics = compute_metrics(no_syc_results, "Without Sycophancy Defense")
    print(f"Agreement with CN: {no_syc_metrics['agreement_with_cn']:.1%}")
    print(f"Precision: {no_syc_metrics['precision']:.4f}, Recall: {no_syc_metrics['recall']:.4f}, F1: {no_syc_metrics['f1']:.4f}")

    # Summary table
    print("\n" + "=" * 70)
    print("SUMMARY: Agreement with Community Notes Decisions")
    print("=" * 70)
    print(f"{'Configuration':<40} {'Agreement':>10} {'Precision':>10} {'Recall':>10} {'F1':>10}")
    print("-" * 80)
    for m in [majority_metrics, weighted_metrics, no_syc_metrics]:
        print(f"{m['name']:<40} {m['agreement_with_cn']:>10.1%} {m['precision']:>10.4f} {m['recall']:>10.4f} {m['f1']:>10.4f}")

    # Analysis: where do we disagree with CN?
    print("\n--- Disagreement Analysis ---")
    disagree = [d for d in decisions if not d["correct"]]
    agree = [d for d in decisions if d["correct"]]
    print(f"Total agreements: {len(agree)} ({len(agree)/len(decisions):.1%})")
    print(f"Total disagreements: {len(disagree)} ({len(disagree)/len(decisions):.1%})")

    if disagree:
        # False positives (we say helpful, CN says not)
        fp_cases = [d for d in disagree if d["predicted"] == "HELPFUL"]
        fn_cases = [d for d in disagree if d["predicted"] == "NOT_HELPFUL"]
        print(f"  False positives (protocol=HELPFUL, CN=NOT_HELPFUL): {len(fp_cases)}")
        print(f"  False negatives (protocol=NOT_HELPFUL, CN=HELPFUL): {len(fn_cases)}")

        # Score distribution for disagreements
        fp_scores = [d["score"] for d in fp_cases]
        fn_scores = [d["score"] for d in fn_cases]
        if fp_scores:
            print(f"  FP avg score: {np.mean(fp_scores):.3f} (borderline cases)")
        if fn_scores:
            print(f"  FN avg score: {np.mean(fn_scores):.3f} (borderline cases)")

    # Save full results
    output = {
        "benchmark": "Community Notes Replay",
        "sample_size": len(sample),
        "results": {
            "majority_vote": majority_metrics,
            "our_protocol": weighted_metrics,
            "no_sycophancy_defense": no_syc_metrics,
        },
        "disagreement_analysis": {
            "total_agreements": len(agree),
            "total_disagreements": len(disagree),
            "false_positives": len([d for d in disagree if d["predicted"] == "HELPFUL"]),
            "false_negatives": len([d for d in disagree if d["predicted"] == "NOT_HELPFUL"]),
        },
    }

    output_path = os.path.join(DATA_DIR, "benchmark_results.json")
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nResults saved to {output_path}")


if __name__ == "__main__":
    main()
