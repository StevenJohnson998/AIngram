"""
Graduated sanctions system for the Deliberative Curation Protocol.

Implements:
- Violation tracking with sliding window
- 6-level escalation: warning -> rate limit -> probation -> review suspended
  -> contribution suspended -> ban
- Broken agent detection via likelihood ratio test (entropy-based)
- Quarantine state for broken agents
- Operator feedback simulation for quarantined agents
"""

import numpy as np
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple, Optional
from src.agents import Agent, AgentType


@dataclass
class ViolationRecord:
    """Tracks violations for a single agent."""
    rounds: List[int] = field(default_factory=list)  # Rounds when violations occurred
    total_violations: int = 0


@dataclass
class ActionRecord:
    """Tracks agent actions for broken detection."""
    votes: List[int] = field(default_factory=list)        # Vote values
    qualities: List[float] = field(default_factory=list)   # Chunk qualities voted on


class SanctionSystem:
    """
    Manages graduated sanctions and broken agent detection.

    Sanctions escalate through 6 levels based on violation count
    within a sliding window. Broken agents are detected by comparing
    their action entropy against a random baseline.
    """

    def __init__(self, config: dict, rng: np.random.Generator):
        self.rng = rng
        sanction_cfg = config["sanctions"]
        self.window = sanction_cfg["window"]
        self.thresholds = sanction_cfg["thresholds"]  # [1, 3, 4, 5, 7, 10]
        self.broken_detection_threshold = sanction_cfg["broken_detection_threshold"]

        # Per-agent violation records
        self.violations: Dict[int, ViolationRecord] = {}
        # Per-agent action records for detection
        self.actions: Dict[int, ActionRecord] = {}
        # Currently quarantined agents
        self.quarantined: Set[int] = set()
        # Quarantine start rounds
        self.quarantine_start: Dict[int, int] = {}

    def init_agent(self, agent_id: int):
        """Initialize tracking for an agent."""
        self.violations[agent_id] = ViolationRecord()
        self.actions[agent_id] = ActionRecord()

    def record_violation(self, agent_id: int, current_round: int):
        """Record a violation for an agent."""
        record = self.violations[agent_id]
        record.rounds.append(current_round)
        record.total_violations += 1

    def record_action(self, agent_id: int, vote_value: int, chunk_quality: float):
        """Record a vote action for broken detection analysis."""
        record = self.actions[agent_id]
        record.votes.append(vote_value)
        record.qualities.append(chunk_quality)

    def get_violation_count(self, agent_id: int, current_round: int) -> int:
        """Count violations within the sliding window."""
        record = self.violations[agent_id]
        return sum(1 for r in record.rounds if current_round - r <= self.window)

    def get_sanction_level(self, agent_id: int, current_round: int) -> int:
        """
        Determine current sanction level (0-5) based on violation count.
        0: no sanction / warning (< thresholds[1])
        1: rate limit (>= thresholds[1])
        2: probation (>= thresholds[2])
        3: review suspended (>= thresholds[3])
        4: contribution suspended (>= thresholds[4])
        5: ban (>= thresholds[5])
        """
        count = self.get_violation_count(agent_id, current_round)
        level = 0
        for i, threshold in enumerate(self.thresholds):
            if count >= threshold:
                level = i
        return level

    def apply_sanctions(self, agent: Agent, current_round: int):
        """
        Apply the appropriate sanction level to an agent.
        Updates agent flags based on current violation count.
        """
        level = self.get_sanction_level(agent.agent_id, current_round)

        # Reset all flags
        agent.rate_limited = False
        agent.probation = False
        agent.review_suspended = False
        agent.contribution_suspended = False

        if agent.is_banned:
            return  # Already banned, no changes

        if level >= 5:
            agent.is_banned = True
        elif level >= 4:
            agent.contribution_suspended = True
            agent.review_suspended = True
        elif level >= 3:
            agent.review_suspended = True
        elif level >= 2:
            agent.probation = True
        elif level >= 1:
            agent.rate_limited = True

    def detect_broken(self, agent_id: int) -> bool:
        """
        Detect if an agent is broken using a likelihood ratio test.

        Compares the entropy of the agent's vote distribution against
        a random baseline. High entropy (close to random) suggests
        a broken agent. Low entropy correlated with quality inversely
        suggests malicious behavior.

        Returns True if agent appears broken (high entropy, low correlation).
        """
        record = self.actions[agent_id]
        if len(record.votes) < 10:
            return False  # Not enough data

        votes = np.array(record.votes)
        qualities = np.array(record.qualities)

        # Compute vote distribution entropy
        vote_counts = np.array([
            np.sum(votes == -1),
            np.sum(votes == 0),
            np.sum(votes == 1)
        ], dtype=float)
        total = vote_counts.sum()
        if total == 0:
            return False

        probs = vote_counts / total
        probs = probs[probs > 0]  # Remove zeros for log
        entropy = -np.sum(probs * np.log2(probs))

        # Random baseline entropy for 3 options = log2(3) ~= 1.585
        random_entropy = np.log2(3)

        # Entropy ratio: how close to random
        entropy_ratio = entropy / random_entropy if random_entropy > 0 else 0

        # Correlation between vote and quality (honest agents have positive correlation)
        # Filter out abstentions for correlation
        mask = votes != 0
        if mask.sum() < 5:
            return False

        correlation = np.corrcoef(votes[mask], qualities[mask])[0, 1]
        if np.isnan(correlation):
            correlation = 0.0

        # Broken = high entropy AND low positive correlation
        # (random voting with occasional correctness)
        score = entropy_ratio * (1.0 - max(0, correlation))

        return score > (self.broken_detection_threshold / 3.0)

    def quarantine_agent(self, agent: Agent, current_round: int):
        """Place an agent in quarantine (contributions held, votes at w_min)."""
        agent.is_quarantined = True
        self.quarantined.add(agent.agent_id)
        self.quarantine_start[agent.agent_id] = current_round

    def process_quarantine(self, agent: Agent, current_round: int) -> bool:
        """
        Process quarantined agent. After a quarantine period (20 rounds),
        simulate operator feedback:
        - 80% chance of correct identification and reclassification

        Returns True if agent was released from quarantine.
        """
        if agent.agent_id not in self.quarantine_start:
            return False

        start = self.quarantine_start[agent.agent_id]
        if current_round - start < 20:
            return False  # Still in quarantine

        # Operator review: 80% correct identification
        if self.rng.random() < 0.8:
            if agent.agent_type == AgentType.BROKEN:
                # Correctly identified as broken: reclassify, reduce penalties
                agent.is_quarantined = False
                self.quarantined.discard(agent.agent_id)
                del self.quarantine_start[agent.agent_id]
                # Clear some violations to give a fresh start
                record = self.violations[agent.agent_id]
                record.rounds = record.rounds[-3:]  # Keep only last 3
                return True
            else:
                # Incorrectly quarantined: release with apology (clear violations)
                agent.is_quarantined = False
                self.quarantined.discard(agent.agent_id)
                del self.quarantine_start[agent.agent_id]
                record = self.violations[agent.agent_id]
                record.rounds = []
                return True
        else:
            # Operator doesn't resolve yet: extend quarantine
            self.quarantine_start[agent.agent_id] = current_round
            return False

    def check_voting_correctness(self, agent_id: int, vote_value: int,
                                 chunk_vote_score: float) -> bool:
        """
        Check if a vote deviates from consensus outcome.
        Used to determine if a violation should be recorded.

        A vote is incorrect if it strongly deviates from the consensus:
        - Agent approved (v=+1) but consensus rejected (score <= -0.2)
        - Agent rejected (v=-1) but consensus approved (score >= 0.3)

        Uses the same tau thresholds as the protocol decision logic.
        """
        if vote_value == 1 and chunk_vote_score <= -0.2:
            return False  # Approved against strong rejection consensus
        if vote_value == -1 and chunk_vote_score >= 0.3:
            return False  # Rejected against strong approval consensus
        return True

    def get_all_sanctioned_agents(self, current_round: int) -> Dict[int, int]:
        """Get all agents with their sanction levels > 0."""
        return {
            aid: self.get_sanction_level(aid, current_round)
            for aid in self.violations
            if self.get_sanction_level(aid, current_round) > 0
        }
