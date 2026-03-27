#!/usr/bin/env python3
"""
Stratified Community Notes replay: analyze protocol performance by rating density.

Low-rating notes (5-20 ratings) are where governance mechanisms matter most.
High-rating notes (100+) are easy for any mechanism.
"""

import json
import os
import sys
import numpy as np
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from reputation import ReputationSystem

DATA_DIR = os.path.dirname(os.path.abspath(__file__))

STRATA = [
    ("sparse (5-15 ratings)", 5, 15),
    ("moderate (16-50 ratings)", 16, 50),
    ("dense (51-200 ratings)", 51, 200),
    ("very dense (200+ ratings)", 201, 99999),
]


def load_sample():
    with open(os.path.join(DATA_DIR, "sample.json")) as f:
        return json.load(f)


def majority_vote_decision(votes):
    pos = sum(1 for v in votes if v["vote"] == 1)
    neg = sum(1 for v in votes if v["vote"] == -1)
    return pos > neg


def run_weighted_protocol(sample, config, simulate_sycophancy=False):
    """Run reputation-weighted protocol, optionally simulating sycophancy."""
    rng = np.random.default_rng(42)
    rep_config = config["reputation"]
    tau_accept = config["voting"]["tau_accept"]

    all_pids = set()
    for note in sample:
        for v in note["votes"]:
            all_pids.add(v["participantId"])
    pid_to_idx = {pid: i for i, pid in enumerate(sorted(all_pids))}

    full_config = {"reputation": rep_config, "sanctions": config.get("sanctions", {"window": 100})}
    rep_system = ReputationSystem(config=full_config, rng=rng)
    for idx in pid_to_idx.values():
        rep_system.init_agent(idx)

    decisions = []
    sorted_sample = sorted(sample, key=lambda n: min(
        (v.get("createdAtMillis", "0") for v in n["votes"]), default="0"
    ))

    for round_idx, note in enumerate(sorted_sample):
        total_weight = 0.0
        weighted_sum = 0.0
        voter_ids = []
        running_sum = 0
        n_independent = max(3, int(len(note["votes"]) * 0.3))

        for i, v in enumerate(note["votes"]):
            pid = v["participantId"]
            if pid not in pid_to_idx:
                continue
            aid = pid_to_idx[pid]
            vote_val = v["vote"]
            if vote_val == 0:
                continue

            # Simulate sycophancy if enabled
            if simulate_sycophancy and i >= n_independent and rng.random() < 0.30:
                vote_val = 1 if running_sum > 0 else -1

            w = rep_system.get_effective_weight(aid)
            weighted_sum += w * vote_val
            total_weight += w
            running_sum += vote_val
            voter_ids.append((aid, vote_val))

        score = weighted_sum / total_weight if total_weight > 0 else 0.0
        predicted_helpful = score >= tau_accept

        decisions.append({
            "noteId": note["noteId"],
            "label": note["label"],
            "predicted": predicted_helpful,
            "n_ratings": note["n_ratings"],
            "score": score,
        })

        # Update reputation (consensus-based)
        noise_rate = rep_config.get("reputation_noise", 0.15)
        for aid, vote_val in voter_ids:
            correct = (vote_val == 1) if predicted_helpful else (vote_val == -1)
            if rng.random() < noise_rate:
                correct = not correct
            amount = 1.0 if abs(score) > 0.5 else 0.4
            rep_system.update_reputation(aid, positive=correct, current_round=round_idx, amount=amount)

        if round_idx % 50 == 49:
            rep_system.compute_eigentrust()

    return decisions


def evaluate_stratum(decisions, label):
    """Compute metrics for a subset of decisions."""
    tp = sum(1 for d in decisions if d["predicted"] and d["label"] == "HELPFUL")
    fp = sum(1 for d in decisions if d["predicted"] and d["label"] != "HELPFUL")
    tn = sum(1 for d in decisions if not d["predicted"] and d["label"] != "HELPFUL")
    fn = sum(1 for d in decisions if not d["predicted"] and d["label"] == "HELPFUL")
    total = tp + fp + tn + fn
    if total == 0:
        return None

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    accuracy = (tp + tn) / total

    return {
        "n": total,
        "accuracy": round(accuracy, 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def main():
    sample = load_sample()
    config_path = os.path.join(DATA_DIR, "..", "config.json")
    with open(config_path) as f:
        config = json.load(f)

    print("=" * 80)
    print("STRATIFIED COMMUNITY NOTES REPLAY BENCHMARK")
    print("=" * 80)
    print(f"Total notes: {len(sample)}")

    # Run all configurations
    all_decisions = {}

    # Ungoverned: accept everything
    print("\n[1/4] Ungoverned (accept all)...")
    all_decisions["Ungoverned"] = [
        {"noteId": n["noteId"], "label": n["label"], "predicted": True, "n_ratings": n["n_ratings"]}
        for n in sample
    ]

    # Majority vote
    print("[2/4] Majority Vote...")
    all_decisions["Majority Vote"] = [
        {"noteId": n["noteId"], "label": n["label"], "predicted": majority_vote_decision(n["votes"]), "n_ratings": n["n_ratings"]}
        for n in sample
    ]

    # Our protocol
    print("[3/4] Our Protocol (reputation-weighted)...")
    all_decisions["Our Protocol"] = run_weighted_protocol(sample, config, simulate_sycophancy=False)

    # Ablation: no sycophancy defense
    print("[4/4] No Sycophancy Defense...")
    all_decisions["No Sycophancy Def."] = run_weighted_protocol(sample, config, simulate_sycophancy=True)

    # Stratified analysis
    for stratum_name, lo, hi in STRATA:
        print(f"\n--- {stratum_name} ---")
        n_notes = sum(1 for n in sample if lo <= n["n_ratings"] <= hi)
        helpful = sum(1 for n in sample if lo <= n["n_ratings"] <= hi and n["label"] == "HELPFUL")
        print(f"Notes: {n_notes} ({helpful} helpful, {n_notes - helpful} not helpful)")

        if n_notes == 0:
            print("  (no notes in this stratum)")
            continue

        print(f"{'Configuration':<25} {'N':>5} {'Agreement':>10} {'Precision':>10} {'Recall':>10} {'F1':>10}")
        print("-" * 75)

        for name, decisions in all_decisions.items():
            stratum_decisions = [d for d in decisions if lo <= d["n_ratings"] <= hi]
            metrics = evaluate_stratum(stratum_decisions, name)
            if metrics:
                print(f"{name:<25} {metrics['n']:>5} {metrics['accuracy']:>10.1%} {metrics['precision']:>10.4f} {metrics['recall']:>10.4f} {metrics['f1']:>10.4f}")

    # Overall
    print(f"\n--- ALL NOTES ---")
    print(f"{'Configuration':<25} {'N':>5} {'Agreement':>10} {'Precision':>10} {'Recall':>10} {'F1':>10}")
    print("-" * 75)
    for name, decisions in all_decisions.items():
        metrics = evaluate_stratum(decisions, name)
        if metrics:
            print(f"{name:<25} {metrics['n']:>5} {metrics['accuracy']:>10.1%} {metrics['precision']:>10.4f} {metrics['recall']:>10.4f} {metrics['f1']:>10.4f}")

    # Key insight
    print("\n" + "=" * 80)
    print("KEY INSIGHT: Protocol value by rating density")
    print("=" * 80)
    for stratum_name, lo, hi in STRATA:
        stratum_ungov = [d for d in all_decisions["Ungoverned"] if lo <= d["n_ratings"] <= hi]
        stratum_majority = [d for d in all_decisions["Majority Vote"] if lo <= d["n_ratings"] <= hi]
        stratum_protocol = [d for d in all_decisions["Our Protocol"] if lo <= d["n_ratings"] <= hi]
        m_ung = evaluate_stratum(stratum_ungov, "")
        m_maj = evaluate_stratum(stratum_majority, "")
        m_pro = evaluate_stratum(stratum_protocol, "")
        if m_ung and m_maj and m_pro:
            print(f"{stratum_name:<30} Ungoverned: {m_ung['precision']:.1%}  Majority: {m_maj['accuracy']:.1%}  Protocol: {m_pro['accuracy']:.1%}  Delta(maj): {m_pro['accuracy'] - m_maj['accuracy']:+.1%}")

    # Save full results as JSON
    results = {"strata": {}, "overall": {}}
    for stratum_name, lo, hi in STRATA:
        stratum_results = {}
        for config_name, decisions in all_decisions.items():
            stratum_d = [d for d in decisions if lo <= d["n_ratings"] <= hi]
            m = evaluate_stratum(stratum_d, config_name)
            if m:
                stratum_results[config_name] = m
        results["strata"][stratum_name] = stratum_results

    for config_name, decisions in all_decisions.items():
        m = evaluate_stratum(decisions, config_name)
        if m:
            results["overall"][config_name] = m

    results_path = os.path.join(DATA_DIR, "stratified_results.json")
    with open(results_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nFull results saved to {results_path}")


if __name__ == "__main__":
    main()
