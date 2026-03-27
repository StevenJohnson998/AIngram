"""
Main simulation runner for Paper 3: Deliberative Curation Protocol.

Runs the full protocol simulation plus 4 baselines and 8 ablations,
producing JSON results and matplotlib plots.

Usage:
    python simulation.py --config config.json --output results/
"""

import argparse
import json
import os
import sys
import time
import warnings
import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")
from typing import Dict, List, Set, Tuple, Optional
from copy import deepcopy

from src.protocol import Protocol, ChunkState, TERMINAL_STATES, DECIDED_STATES
from src.reputation import ReputationSystem
from src.agents import (
    Agent, AgentType, create_agents, generate_chunk_quality,
    vote, should_submit_argument, should_contribute_duplicate,
)
from src.sanctions import SanctionSystem
from src.metrics import MetricsTracker, save_results, generate_plots


# ---------------------------------------------------------------------------
# Simulation engine
# ---------------------------------------------------------------------------

class Simulation:
    """
    Core simulation engine. Runs N rounds of the deliberative curation
    protocol with configurable ablations and baseline modes.
    """

    def __init__(self, config: dict, mode: str = "full_protocol", seed: int = 42):
        """
        Args:
            config: Full configuration dict from config.json.
            mode: One of "full_protocol", baseline names, or ablation names.
            seed: Random seed for reproducibility.
        """
        self.config = config
        self.mode = mode
        self.current_round = 0
        self.reputation_noise = config["reputation"].get("reputation_noise", 0.15)
        # Track chunks retracted via disputes for delayed reputation feedback
        self.retracted_chunks: List[int] = []

        # Use separate RNG for agent creation (deterministic across modes)
        # and a different one for simulation dynamics
        agent_rng = np.random.default_rng(seed)
        self.rng = np.random.default_rng(seed + 1000)

        # Initialize subsystems
        self.reputation = ReputationSystem(config, self.rng)
        self.protocol = Protocol(config, self.reputation, self.rng)
        self.sanctions = SanctionSystem(config, self.rng)
        self.metrics = MetricsTracker()

        # Create agents with a fixed RNG so all modes get the same population
        self.agents = create_agents(config, agent_rng)
        self.agent_map: Dict[int, Agent] = {a.agent_id: a for a in self.agents}

        # Initialize agent reputation and sanctions
        for agent in self.agents:
            # Mark some honest agents as pre-trusted for EigenTrust seeding
            pre_trusted = (agent.agent_type == AgentType.HONEST and
                           self.rng.random() < 0.1)
            self.reputation.init_agent(agent.agent_id, pre_trusted=pre_trusted)
            self.sanctions.init_agent(agent.agent_id)

        # Apply mode-specific configuration
        self._configure_mode()

    def _configure_mode(self):
        """Apply ablation or baseline configuration."""
        # Baselines
        if self.mode == "majority_vote":
            # Equal weights, no reputation, no sanctions, no deliberation
            self._disable_reputation()
            self._disable_sanctions()
            self._disable_deliberation()
        elif self.mode == "single_curator":
            # Only one reviewer (highest rep), no deliberation
            self.protocol.k_reviewers = 1
            self.protocol.q_min = 1
            self._disable_deliberation()
        elif self.mode == "ungoverned":
            # Everything passes (tau_accept = -999)
            self.protocol.tau_accept = -999.0
            self._disable_sanctions()
            self._disable_reputation()
        elif self.mode == "weighted_no_deliberation":
            # Reputation-weighted but no deliberation bonus
            self._disable_deliberation()

        # Ablations
        elif self.mode == "no_reputation":
            self._disable_reputation()
        elif self.mode == "no_sanctions":
            self._disable_sanctions()
        elif self.mode == "no_deliberation":
            self._disable_deliberation()
        elif self.mode == "no_decay":
            self.reputation.decay = 0.0
        elif self.mode == "no_broken_handling":
            self.sanctions.broken_detection_threshold = 999.0  # Never detect
        elif self.mode == "no_sycophancy_defense":
            self.protocol.commit_reveal = False
        elif self.mode == "no_farming_cap":
            self.reputation.farming_cap = 999.0  # Effectively no cap
        elif self.mode == "no_dispute_limit":
            self.protocol.d_max_per_chunk = 999
            self.protocol.d_agent_per_window = 999

    def _disable_reputation(self):
        """Set all agents to equal weight."""
        self.reputation.alpha_blend = 0.0
        self.reputation.decay = 0.0
        for aid in self.reputation.states:
            self.reputation.states[aid].alpha = 1.0
            self.reputation.states[aid].beta = 1.0
            self.reputation.states[aid].eigentrust_score = 1.0 / len(self.agents)
        self._reputation_disabled = True

    def _disable_sanctions(self):
        """Disable all sanctions."""
        self._sanctions_disabled = True

    def _disable_deliberation(self):
        """Disable deliberation bonus."""
        self.protocol.deliberation_bonus = 0.0
        self.protocol.novelty_bonus = 0.0
        self._deliberation_disabled = True

    @property
    def _reputation_disabled(self):
        return getattr(self, "__reputation_disabled", False)

    @_reputation_disabled.setter
    def _reputation_disabled(self, val):
        self.__reputation_disabled = val

    @property
    def _sanctions_disabled(self):
        return getattr(self, "__sanctions_disabled", False)

    @_sanctions_disabled.setter
    def _sanctions_disabled(self, val):
        self.__sanctions_disabled = val

    @property
    def _deliberation_disabled(self):
        return getattr(self, "__deliberation_disabled", False)

    @_deliberation_disabled.setter
    def _deliberation_disabled(self, val):
        self.__deliberation_disabled = val

    def run(self) -> Dict:
        """Run the full simulation and return results."""
        n_rounds = self.config["n_rounds"]
        chunks_per_round = self.config["chunks_per_round"]

        for round_num in range(n_rounds):
            self.current_round = round_num

            # 1. Apply time decay to reputations
            if not self._reputation_disabled:
                for agent in self.agents:
                    self.reputation.apply_decay(agent.agent_id, round_num)

            # 2. Propose new chunks
            self._propose_chunks(chunks_per_round)

            # 3. Assign reviewers and collect votes for chunks under review
            self._review_and_vote()

            # 4. Apply decisions
            self._apply_decisions()

            # 5. Update reputations based on outcomes
            if not self._reputation_disabled:
                self._update_reputations()

            # 6. Check sanctions
            if not self._sanctions_disabled:
                self._check_sanctions()

            # 7. Process disputes (small chance per round)
            self._process_disputes()

            # 8. Process quarantined agents
            if not self._sanctions_disabled:
                self._process_quarantines()

            # 9. Recompute EigenTrust periodically
            if not self._reputation_disabled and round_num % 10 == 0:
                self.reputation.compute_eigentrust()

            # 10. Record metrics
            self.metrics.record_round(
                list(self.protocol.chunks.values()),
                self.agents,
                self.reputation,
                self.sanctions,
                round_num,
            )

        # Final EigenTrust computation
        if not self._reputation_disabled:
            self.reputation.compute_eigentrust()

        # Compile results
        all_chunks = list(self.protocol.chunks.values())
        summary = self.metrics.get_summary(
            all_chunks, self.agents, self.reputation,
            self.sanctions, self.current_round,
        )
        summary["mode"] = self.mode
        summary["n_agents"] = len(self.agents)
        summary["n_chunks_total"] = len(all_chunks)
        summary["n_active"] = sum(1 for c in all_chunks if c.state == ChunkState.ACTIVE)
        summary["n_rejected"] = sum(1 for c in all_chunks if c.state == ChunkState.REJECTED)
        summary["n_disputed"] = sum(1 for c in all_chunks if c.state == ChunkState.DISPUTED)
        summary["reputation_history"] = self.metrics.reputation_history

        return summary

    def _propose_chunks(self, count: int):
        """Have random agents propose new chunks."""
        eligible = [
            a for a in self.agents
            if not a.is_banned and not a.contribution_suspended and not a.is_quarantined
        ]
        if not eligible:
            return

        for _ in range(count):
            contributor = self.rng.choice(eligible)
            quality = generate_chunk_quality(contributor, self.rng)

            # Broken agents may submit duplicates
            if should_contribute_duplicate(contributor, self.rng):
                # Submit a duplicate (same quality, still a new chunk)
                quality = max(0.1, quality - 0.1)

            self.protocol.create_chunk(
                contributor.agent_id, quality, self.current_round
            )

    def _review_and_vote(self):
        """Assign reviewers and collect votes for all proposed chunks."""
        proposed = self.protocol.get_chunks_in_state(ChunkState.PROPOSED)
        disputed = self.protocol.get_chunks_in_state(ChunkState.DISPUTED)

        # Get suspended agents
        suspended = {
            a.agent_id for a in self.agents
            if a.review_suspended or a.is_banned or a.is_quarantined
        }

        all_agent_ids = [a.agent_id for a in self.agents if not a.is_banned]

        for chunk in proposed + disputed:
            reviewers = self.protocol.assign_reviewers(chunk, all_agent_ids, suspended)
            if not reviewers:
                continue

            for reviewer_id in reviewers:
                agent = self.agent_map[reviewer_id]

                # Skip if agent crashes (broken agents)
                if agent.agent_type == AgentType.BROKEN and self.rng.random() < 0.05:
                    continue

                # Get vote
                v = vote(
                    agent, chunk.quality, self.rng,
                    reputation_system=self.reputation,
                    chunk=chunk,
                    commit_reveal=self.protocol.commit_reveal,
                )

                # Deliberation: tier >= 1 agents may submit arguments
                has_arg = False
                if not self._deliberation_disabled:
                    tier = self.reputation.get_tier(reviewer_id)
                    if tier >= 1:
                        has_arg = should_submit_argument(agent, self.rng)

                self.protocol.submit_vote(chunk, reviewer_id, v, has_argument=has_arg)

                # Record action for broken detection
                self.sanctions.record_action(reviewer_id, v, chunk.quality)

    def _apply_decisions(self):
        """Apply voting decisions to all chunks under review."""
        under_review = self.protocol.get_chunks_in_state(ChunkState.UNDER_REVIEW)

        for chunk in under_review:
            old_state = chunk.state
            new_state = self.protocol.decide(chunk, self.current_round)

            # Award deliberation bonuses to agents who argued AND voted with consensus
            if not self._deliberation_disabled and new_state in (ChunkState.ACTIVE, ChunkState.REJECTED):
                delib_agents = self.protocol.get_deliberation_agents(chunk)
                chunk_accepted = new_state == ChunkState.ACTIVE
                for aid in delib_agents:
                    vote_obj = chunk.votes.get(aid)
                    if vote_obj is None:
                        continue
                    # Reward if the argument aligned with the consensus outcome
                    vote_correct = (vote_obj.value == 1 and chunk_accepted) or \
                                   (vote_obj.value == -1 and not chunk_accepted)
                    if vote_correct:
                        self.reputation.update_reputation(
                            aid, positive=True, current_round=self.current_round,
                            amount=self.protocol.deliberation_bonus,
                        )

    def _update_reputations(self):
        """
        Update reputations based on observable signals (no ground-truth oracle).

        Correctness is determined by consensus-based signal:
        - A vote is "correct" if it aligns with the final weighted decision
          (ACTIVE = consensus approved, REJECTED = consensus rejected).
        - With probability `reputation_noise`, the correctness signal is flipped
          to model real-world noise where consensus isn't always right.
        - Dispute signal (stronger): if a previously accepted chunk is retracted
          via dispute, all agents who approved it get a negative update.
        """
        noise_rate = self.reputation_noise

        for chunk in self.protocol.chunks.values():
            if chunk.decided_round != self.current_round:
                continue

            # Consensus outcome: was the chunk accepted or rejected?
            chunk_accepted = chunk.state == ChunkState.ACTIVE

            for vote_obj in chunk.votes.values():
                if not vote_obj.revealed:
                    continue

                agent_id = vote_obj.agent_id
                vote_val = vote_obj.value

                if vote_val == 0:
                    continue

                # Consensus-based correctness: vote aligns with final decision
                correct = (vote_val == 1 and chunk_accepted) or \
                          (vote_val == -1 and not chunk_accepted)

                # Add noise: flip correctness with probability noise_rate
                if self.rng.random() < noise_rate:
                    correct = not correct

                # Signal strength based on vote score magnitude
                # Strong consensus = stronger signal, weak consensus = weaker signal
                score_magnitude = abs(chunk.vote_score)
                if score_magnitude >= 0.5:
                    amount = 1.0  # Strong consensus
                else:
                    amount = 0.4  # Weak consensus

                self.reputation.update_reputation(
                    agent_id, positive=correct,
                    current_round=self.current_round,
                    amount=amount,
                )

                # Record interaction: voter -> contributor
                self.reputation.record_interaction(
                    agent_id, chunk.contributor_id, correct
                )

            # Novelty bonus for contributor if chunk survived disputes
            if chunk.state == ChunkState.ACTIVE and chunk.dispute_count > 0:
                self.reputation.update_reputation(
                    chunk.contributor_id, positive=True,
                    current_round=self.current_round,
                    amount=self.protocol.novelty_bonus,
                )

        # Dispute signal: penalize agents who approved chunks that were retracted
        self._apply_dispute_feedback()

    def _apply_dispute_feedback(self):
        """
        Delayed reputation feedback: if a chunk that was accepted is later
        retracted (via dispute), all agents who approved it get a negative
        update. This is the strongest real-world signal.
        """
        for chunk in self.protocol.chunks.values():
            if chunk.state != ChunkState.RETRACTED:
                continue
            if chunk.chunk_id in self.retracted_chunks:
                continue  # Already processed

            self.retracted_chunks.append(chunk.chunk_id)

            # Penalize all agents who voted +1 on this chunk
            for vote_obj in chunk.votes.values():
                if vote_obj.value == 1 and vote_obj.revealed:
                    self.reputation.update_reputation(
                        vote_obj.agent_id, positive=False,
                        current_round=self.current_round,
                        amount=2.0,  # Strong negative signal
                    )

    def _check_sanctions(self):
        """Check for violations and apply sanctions."""
        # Look at chunks decided this round
        for chunk in self.protocol.chunks.values():
            if chunk.decided_round != self.current_round:
                continue

            for vote_obj in chunk.votes.values():
                if not vote_obj.revealed or vote_obj.value == 0:
                    continue

                # Check if vote deviates from consensus
                correct = self.sanctions.check_voting_correctness(
                    vote_obj.agent_id, vote_obj.value, chunk.vote_score
                )
                if not correct:
                    self.sanctions.record_violation(
                        vote_obj.agent_id, self.current_round
                    )

        # Apply sanctions to all agents
        for agent in self.agents:
            self.sanctions.apply_sanctions(agent, self.current_round)

        # Broken detection (every 25 rounds)
        if self.current_round % 25 == 0 and self.current_round > 0:
            for agent in self.agents:
                if agent.is_banned or agent.is_quarantined:
                    continue
                if self.sanctions.detect_broken(agent.agent_id):
                    self.sanctions.quarantine_agent(agent, self.current_round)

    def _process_disputes(self):
        """Process potential disputes on active chunks."""
        active_chunks = self.protocol.get_active_chunks()
        if not active_chunks:
            return

        # Small probability of dispute per round from tier-2 agents
        tier2_agents = [
            a for a in self.agents
            if (self.reputation.get_tier(a.agent_id) >= 2
                and not a.is_banned and not a.is_quarantined)
        ]

        for agent in tier2_agents:
            if self.rng.random() > 0.02:  # 2% chance per tier-2 agent per round
                continue

            # Pick a random active chunk to potentially dispute
            chunk = self.rng.choice(active_chunks)

            # Malicious agents dispute good chunks; honest agents dispute bad ones
            should_dispute = False
            if agent.agent_type == AgentType.MALICIOUS and chunk.quality >= 0.7:
                should_dispute = True
            elif agent.agent_type == AgentType.HONEST and chunk.quality < 0.3:
                should_dispute = True
            elif agent.agent_type == AgentType.STRATEGIC and agent.gaming_mode:
                should_dispute = (chunk.quality >= 0.6 and self.rng.random() < 0.3)
            elif agent.agent_type == AgentType.ADAPTIVE and agent.adaptive_phase == 2:
                should_dispute = (chunk.quality >= 0.7 and self.rng.random() < 0.3)

            if should_dispute:
                self.protocol.dispute(chunk, agent.agent_id, self.current_round)

    def _process_quarantines(self):
        """Process quarantined agents for possible release."""
        quarantined = [a for a in self.agents if a.is_quarantined]
        for agent in quarantined:
            self.sanctions.process_quarantine(agent, self.current_round)


# ---------------------------------------------------------------------------
# Run configurations
# ---------------------------------------------------------------------------

def run_all(config: dict, output_dir: str, n_seeds: int = 5):
    """
    Run all configurations across multiple seeds for statistical robustness.
    Reports mean +/- std for each metric.
    """
    base_seed = config["seed"]
    seeds = [base_seed + i * 100 for i in range(n_seeds)]

    configurations = [
        # Full protocol
        "full_protocol",
        # Baselines
        "majority_vote",
        "single_curator",
        "ungoverned",
        "weighted_no_deliberation",
        # Ablations
        "no_reputation",
        "no_sanctions",
        "no_deliberation",
        "no_decay",
        "no_broken_handling",
        "no_sycophancy_defense",
        "no_farming_cap",
        "no_dispute_limit",
    ]

    # Collect results per mode across seeds
    # mode -> metric_name -> list of values (one per seed)
    aggregated: Dict[str, Dict[str, List]] = {
        mode: {"precision": [], "recall": [], "gini": [],
               "sanction_fpr": [], "convergence_time": [], "throughput": []}
        for mode in configurations
    }

    # Store the last seed's results for time series plots
    last_seed_results: Dict[str, Dict] = {}

    total_runs = len(configurations) * n_seeds
    run_idx = 0

    for seed in seeds:
        print(f"\n--- Seed {seed} ---")
        for mode in configurations:
            run_idx += 1
            print(f"[{run_idx}/{total_runs}] {mode}...", end=" ", flush=True)
            start = time.time()

            sim = Simulation(config, mode=mode, seed=seed)
            results = sim.run()

            elapsed = time.time() - start
            print(f"done ({elapsed:.1f}s) | P={results['precision']:.3f} "
                  f"R={results['recall']:.3f}")

            # Aggregate scalar metrics
            for metric in aggregated[mode]:
                aggregated[mode][metric].append(results[metric])

            # Keep last seed's results for plotting
            if seed == seeds[-1]:
                last_seed_results[mode] = results

    # Compute mean/std and build final results for saving
    all_results = {}
    for mode in configurations:
        mode_result = {}
        for metric, values in aggregated[mode].items():
            mode_result[f"{metric}_mean"] = float(np.mean(values))
            mode_result[f"{metric}_std"] = float(np.std(values))
            mode_result[metric] = float(np.mean(values))  # For backward compat
        mode_result["mode"] = mode
        mode_result["n_seeds"] = n_seeds
        # Save per-seed values for statistical tests
        for metric, values in aggregated[mode].items():
            mode_result[f"{metric}_per_seed"] = [float(v) for v in values]
        # Add time series from last seed for plots
        if mode in last_seed_results:
            for key in ("precision_history", "recall_history", "gini_history",
                        "throughput_history", "sanction_fpr_history",
                        "reputation_history"):
                if key in last_seed_results[mode]:
                    mode_result[key] = last_seed_results[mode][key]
        all_results[mode] = mode_result
        save_results(mode_result, output_dir, mode)

    # Generate plots from last seed's time series
    print("\nGenerating plots...", end=" ", flush=True)
    generate_plots(last_seed_results, output_dir)
    print("done")

    # Print summary table with mean +/- std
    print(f"\n{'=' * 100}")
    print(f"Results averaged over {n_seeds} seeds (mean +/- std)")
    print(f"{'=' * 100}")
    print(f"{'Configuration':<30} {'Precision':>16} {'Recall':>16} "
          f"{'Gini':>16} {'FPR':>16}")
    print("-" * 100)
    for mode in configurations:
        a = aggregated[mode]
        print(f"{mode:<30} "
              f"{np.mean(a['precision']):>7.3f}+/-{np.std(a['precision']):.3f} "
              f"{np.mean(a['recall']):>7.3f}+/-{np.std(a['recall']):.3f} "
              f"{np.mean(a['gini']):>7.3f}+/-{np.std(a['gini']):.3f} "
              f"{np.mean(a['sanction_fpr']):>7.3f}+/-{np.std(a['sanction_fpr']):.3f}")
    print(f"{'=' * 100}")

    # Statistical significance tests (paired t-tests on precision)
    from scipy import stats as scipy_stats
    fp_prec = aggregated["full_protocol"]["precision"]
    comparisons = [
        ("majority_vote", "Majority vote"),
        ("weighted_no_deliberation", "Weighted no-delib"),
        ("no_sycophancy_defense", "No sycophancy defense"),
        ("no_reputation", "No reputation"),
        ("no_farming_cap", "No farming cap"),
        ("no_deliberation", "No deliberation"),
    ]
    print(f"\n{'Paired t-tests (precision, full protocol vs ...)':^80}")
    print("-" * 80)
    pvalues = {}
    for mode_key, label in comparisons:
        other = aggregated[mode_key]["precision"]
        t_stat, p_val = scipy_stats.ttest_rel(fp_prec, other)
        diff = np.mean(fp_prec) - np.mean(other)
        sig = "***" if p_val < 0.001 else "**" if p_val < 0.01 else "*" if p_val < 0.05 else "ns"
        print(f"  vs {label:<30} Δ={diff:+.4f}  t={t_stat:>7.3f}  p={p_val:.6f} {sig}")
        pvalues[mode_key] = {"t": float(t_stat), "p": float(p_val), "delta": float(diff)}
    print("-" * 80)

    # Save aggregated summary
    summary = {
        mode: {
            metric: {"mean": float(np.mean(vals)), "std": float(np.std(vals)),
                     "per_seed": [float(v) for v in vals]}
            for metric, vals in aggregated[mode].items()
        }
        for mode in configurations
    }
    summary["_pvalues"] = pvalues
    save_results(summary, output_dir, "summary")

    return all_results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Paper 3: Deliberative Curation Protocol - ABM Simulation"
    )
    parser.add_argument("--config", default="config.json",
                        help="Path to config.json")
    parser.add_argument("--output", default="results/",
                        help="Output directory for results and plots")
    parser.add_argument("--mode", default=None,
                        help="Run a single mode instead of all")
    parser.add_argument("--seeds", type=int, default=10,
                        help="Number of random seeds for multi-seed runs (default: 10)")
    args = parser.parse_args()

    # Load config
    with open(args.config) as f:
        config = json.load(f)

    print(f"Paper 3: Deliberative Curation Protocol Simulation")
    print(f"Agents: {config['n_agents']}, Rounds: {config['n_rounds']}, "
          f"Seeds: {args.seeds} (base={config['seed']})")
    print(f"Output: {args.output}")
    print()

    if args.mode:
        # Single mode
        sim = Simulation(config, mode=args.mode, seed=config["seed"])
        results = sim.run()
        save_results(results, args.output, args.mode)
        print(f"{args.mode}: precision={results['precision']:.3f} "
              f"recall={results['recall']:.3f}")
    else:
        # Run all configurations across multiple seeds
        run_all(config, args.output, n_seeds=args.seeds)


if __name__ == "__main__":
    main()
