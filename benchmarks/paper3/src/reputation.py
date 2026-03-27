"""
Reputation system for the Deliberative Curation Protocol.

Implements:
- Beta Reputation System: r(a) = alpha / (alpha + beta)
- Time decay on alpha/beta
- EigenTrust global amplification via power iteration
- Tier system with weight bounds
- Reputation farming cap
"""

import numpy as np
from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional


@dataclass
class ReputationState:
    """Per-agent reputation state."""
    alpha: float = 1.0
    beta: float = 1.0
    last_update: int = 0
    eigentrust_score: float = 0.0
    # Track reputation gain in current window for farming cap
    gain_this_window: float = 0.0
    window_start: int = 0


class ReputationSystem:
    """
    Manages reputation for all agents using Beta Reputation + EigenTrust.

    The effective weight of an agent blends local (Beta) and global (EigenTrust)
    scores, bounded by [w_min, w_max] and gated by tier thresholds.
    """

    def __init__(self, config: dict, rng: np.random.Generator):
        self.rng = rng
        rep_cfg = config["reputation"]
        self.alpha_init = rep_cfg["alpha_init"]
        self.beta_init = rep_cfg["beta_init"]
        self.decay = rep_cfg["decay"]
        self.w_min = rep_cfg["w_min"]
        self.w_max = rep_cfg["w_max"]
        self.alpha_blend = rep_cfg["alpha_blend"]
        self.eigentrust_epsilon = rep_cfg["eigentrust_epsilon"]
        self.eigentrust_iterations = rep_cfg["eigentrust_iterations"]
        self.tier_thresholds = rep_cfg["tier_thresholds"]  # [t0, t1, t2]
        self.farming_cap = rep_cfg["farming_cap_per_window"]
        self.farming_window = config["sanctions"]["window"]

        # Agent states: agent_id -> ReputationState
        self.states: Dict[int, ReputationState] = {}
        # Interaction history for EigenTrust: (i, j) -> (positive_count, total_count)
        self.interactions: Dict[Tuple[int, int], Tuple[int, int]] = {}
        # Pre-trusted agent set (honest seeds for EigenTrust)
        self.pre_trusted: set = set()

    def init_agent(self, agent_id: int, pre_trusted: bool = False):
        """Initialize reputation state for a new agent."""
        self.states[agent_id] = ReputationState(
            alpha=self.alpha_init,
            beta=self.beta_init,
        )
        if pre_trusted:
            self.pre_trusted.add(agent_id)

    def get_local_reputation(self, agent_id: int) -> float:
        """Beta reputation: r(a) = alpha / (alpha + beta)."""
        s = self.states[agent_id]
        return s.alpha / (s.alpha + s.beta)

    def get_tier(self, agent_id: int) -> int:
        """
        Determine agent tier based on local reputation.
        Tier 0: newcomer (first n interactions, forced w_min)
        Tier 1: r >= tier_thresholds[1]
        Tier 2: r >= tier_thresholds[2] (can dispute)
        """
        r = self.get_local_reputation(agent_id)
        s = self.states[agent_id]
        total_interactions = s.alpha + s.beta - 2 * self.alpha_init
        # Newcomer: fewer than 5 interactions
        if total_interactions < 5:
            return 0
        if r >= self.tier_thresholds[2]:
            return 2
        if r >= self.tier_thresholds[1]:
            return 1
        return 0

    def apply_decay(self, agent_id: int, current_round: int):
        """
        Apply exponential time decay to alpha and beta.
        Only decays if the agent has been idle (not updated) for more than
        a grace period, to avoid penalizing active participants.
        """
        s = self.states[agent_id]
        grace_period = 5  # No decay for agents active in the last 5 rounds
        if current_round > s.last_update + grace_period:
            dt = current_round - s.last_update - grace_period
            decay_factor = np.exp(-self.decay * dt)
            # Decay toward prior (1.0) -- decay the excess above prior
            s.alpha = self.alpha_init + (s.alpha - self.alpha_init) * decay_factor
            s.beta = self.beta_init + (s.beta - self.beta_init) * decay_factor

    def update_reputation(self, agent_id: int, positive: bool, current_round: int,
                          amount: float = 1.0):
        """
        Update an agent's Beta reputation after an observation.
        Respects the farming cap per window.
        """
        s = self.states[agent_id]

        # Reset farming window if needed
        if current_round - s.window_start >= self.farming_window:
            s.gain_this_window = 0.0
            s.window_start = current_round

        if positive:
            # Check farming cap
            if s.gain_this_window >= self.farming_cap:
                return  # Capped
            effective = min(amount, self.farming_cap - s.gain_this_window)
            s.alpha += effective
            s.gain_this_window += effective
        else:
            s.beta += amount

        s.last_update = current_round

    def record_interaction(self, from_id: int, to_id: int, positive: bool):
        """Record a pairwise interaction for EigenTrust computation."""
        key = (from_id, to_id)
        pos, total = self.interactions.get(key, (0, 0))
        if positive:
            pos += 1
        total += 1
        self.interactions[key] = (pos, total)

    def compute_eigentrust(self) -> Dict[int, float]:
        """
        Run EigenTrust power iteration to compute global trust scores.

        1. Build normalized trust matrix C from interaction history
        2. Power iteration: t = (1-eps)*C^T*t + eps*p
        3. Return trust vector
        """
        agent_ids = sorted(self.states.keys())
        n = len(agent_ids)
        if n == 0:
            return {}

        id_to_idx = {aid: i for i, aid in enumerate(agent_ids)}

        # Build trust matrix C[i][j] = normalized positive interactions from i to j
        C = np.zeros((n, n))
        for (i_id, j_id), (pos, total) in self.interactions.items():
            if i_id in id_to_idx and j_id in id_to_idx:
                i = id_to_idx[i_id]
                j = id_to_idx[j_id]
                if total > 0:
                    C[i][j] = max(0, pos / total)

        # Normalize rows
        row_sums = C.sum(axis=1, keepdims=True)
        row_sums[row_sums == 0] = 1.0  # Avoid division by zero
        C = C / row_sums

        # Pre-trusted distribution
        p = np.zeros(n)
        if self.pre_trusted:
            for aid in self.pre_trusted:
                if aid in id_to_idx:
                    p[id_to_idx[aid]] = 1.0
            p_sum = p.sum()
            if p_sum > 0:
                p /= p_sum
        else:
            p = np.ones(n) / n

        # Power iteration
        t = np.ones(n) / n
        eps = self.eigentrust_epsilon
        for _ in range(self.eigentrust_iterations):
            t_new = (1 - eps) * C.T @ t + eps * p
            t_sum = t_new.sum()
            if t_sum > 0:
                t_new /= t_sum
            t = t_new

        # Store results
        result = {}
        for aid in agent_ids:
            idx = id_to_idx[aid]
            self.states[aid].eigentrust_score = t[idx]
            result[aid] = t[idx]

        return result

    def get_effective_weight(self, agent_id: int) -> float:
        """
        Blended weight: w(a) = alpha_blend * r(a) + (1-alpha_blend) * t(a)
        Squared to amplify differences between high and low reputation agents.
        Bounded by [w_min, w_max]. Tier 0 agents get w_min.
        """
        tier = self.get_tier(agent_id)
        if tier == 0:
            return self.w_min

        r = self.get_local_reputation(agent_id)
        t = self.states[agent_id].eigentrust_score
        w = self.alpha_blend * r + (1 - self.alpha_blend) * t
        # Square the weight to amplify differences
        w = w * w
        return np.clip(w, self.w_min, self.w_max)

    def get_all_weights(self) -> Dict[int, float]:
        """Get effective weights for all agents."""
        return {aid: self.get_effective_weight(aid) for aid in self.states}

    def get_reputation_distribution(self) -> List[float]:
        """Get list of all local reputations for metrics computation."""
        return [self.get_local_reputation(aid) for aid in sorted(self.states.keys())]
