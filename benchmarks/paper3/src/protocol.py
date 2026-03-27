"""
Core protocol for the Deliberative Curation Protocol.

Implements the Labelled Transition System (LTS) for chunk lifecycle,
reputation-weighted voting, commit-reveal scheme, quorum enforcement,
disputes with rate limiting, and deliberation/novelty bonuses.
"""

import numpy as np
from enum import Enum
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple


class ChunkState(Enum):
    """LTS states for chunk lifecycle."""
    PROPOSED = "proposed"
    UNDER_REVIEW = "under_review"
    ACTIVE = "active"
    REJECTED = "rejected"
    DISPUTED = "disputed"
    SUPERSEDED = "superseded"
    RETRACTED = "retracted"


# Terminal states where no further transitions are possible
# Note: ACTIVE is NOT terminal -- active chunks can still be disputed/retracted
TERMINAL_STATES = {ChunkState.REJECTED, ChunkState.SUPERSEDED, ChunkState.RETRACTED}

# Decided states: chunks that have reached a decision (used for metrics)
# Includes ACTIVE because it has been decided upon, even though it can still transition
DECIDED_STATES = {ChunkState.ACTIVE, ChunkState.REJECTED, ChunkState.SUPERSEDED, ChunkState.RETRACTED}


@dataclass
class Vote:
    """A single vote from an agent on a chunk."""
    agent_id: int
    value: int  # +1, -1, or 0
    revealed: bool = False
    has_argument: bool = False  # Whether agent submitted a deliberation argument


@dataclass
class Chunk:
    """A knowledge chunk with its lifecycle state and metadata."""
    chunk_id: int
    contributor_id: int
    quality: float  # Ground truth quality [0, 1]
    state: ChunkState = ChunkState.PROPOSED
    created_round: int = 0
    decided_round: Optional[int] = None
    votes: Dict[int, Vote] = field(default_factory=dict)
    reviewers: List[int] = field(default_factory=list)
    dispute_count: int = 0
    vote_score: float = 0.0  # Cached weighted vote score


class Protocol:
    """
    Manages chunk lifecycle transitions, voting, and disputes.

    The protocol follows an LTS where transitions are guarded by
    quorum requirements, reputation thresholds, and vote scores.
    """

    def __init__(self, config: dict, reputation_system, rng: np.random.Generator):
        self.rng = rng
        self.reputation = reputation_system
        voting_cfg = config["voting"]
        dispute_cfg = config["disputes"]

        self.tau_accept = voting_cfg["tau_accept"]
        self.tau_reject = voting_cfg["tau_reject"]
        self.q_min = voting_cfg["q_min"]
        self.k_reviewers = voting_cfg["k_reviewers"]
        self.deliberation_bonus = voting_cfg["deliberation_bonus"]
        self.novelty_bonus = voting_cfg["novelty_bonus"]

        self.d_max_per_chunk = dispute_cfg["d_max_per_chunk"]
        self.d_agent_per_window = dispute_cfg["d_agent_per_window"]
        self.r_dispute_min = dispute_cfg["r_dispute_min"]
        self.dispute_window = config["sanctions"]["window"]

        # All chunks
        self.chunks: Dict[int, Chunk] = {}
        self.next_chunk_id = 0

        # Dispute tracking: agent_id -> list of rounds when they disputed
        self.dispute_history: Dict[int, List[int]] = {}

        # Commit-reveal mode (can be toggled for ablations)
        self.commit_reveal = True

    def create_chunk(self, contributor_id: int, quality: float, current_round: int) -> Chunk:
        """Create a new chunk in PROPOSED state."""
        chunk = Chunk(
            chunk_id=self.next_chunk_id,
            contributor_id=contributor_id,
            quality=quality,
            state=ChunkState.PROPOSED,
            created_round=current_round,
        )
        self.chunks[chunk.chunk_id] = chunk
        self.next_chunk_id += 1
        return chunk

    def assign_reviewers(self, chunk: Chunk, available_agents: List[int],
                         suspended_agents: Set[int]) -> List[int]:
        """
        Assign k_reviewers to a chunk, weighted by reputation.
        Excludes the contributor and suspended agents.
        """
        candidates = [
            a for a in available_agents
            if a != chunk.contributor_id and a not in suspended_agents
        ]
        if len(candidates) < self.q_min:
            return []  # Not enough reviewers

        k = min(self.k_reviewers, len(candidates))
        weights = np.array([
            max(self.reputation.get_effective_weight(a), 0.01) for a in candidates
        ])
        weights /= weights.sum()

        selected = self.rng.choice(candidates, size=k, replace=False, p=weights)
        chunk.reviewers = list(selected)
        chunk.state = ChunkState.UNDER_REVIEW
        return chunk.reviewers

    def submit_vote(self, chunk: Chunk, agent_id: int, value: int,
                    has_argument: bool = False):
        """
        Submit a vote on a chunk. In commit-reveal mode, vote is hidden
        until reveal phase.
        """
        if chunk.state != ChunkState.UNDER_REVIEW and chunk.state != ChunkState.DISPUTED:
            return
        if agent_id not in chunk.reviewers:
            return

        vote = Vote(
            agent_id=agent_id,
            value=value,
            revealed=not self.commit_reveal,  # Auto-reveal if commit-reveal is off
            has_argument=has_argument,
        )
        chunk.votes[agent_id] = vote

    def reveal_votes(self, chunk: Chunk):
        """Reveal all committed votes (commit-reveal phase 2)."""
        for vote in chunk.votes.values():
            vote.revealed = True

    def compute_vote_score(self, chunk: Chunk) -> float:
        """
        Compute reputation-weighted vote score:
        V(c) = sum(w(a_i) * v(a_i, c)) for all revealed votes.
        Normalized by sum of weights.
        """
        total_weight = 0.0
        weighted_sum = 0.0

        for vote in chunk.votes.values():
            if not vote.revealed:
                continue
            w = self.reputation.get_effective_weight(vote.agent_id)
            weighted_sum += w * vote.value
            total_weight += w

        if total_weight == 0:
            return 0.0

        score = weighted_sum / total_weight
        chunk.vote_score = score
        return score

    def check_quorum(self, chunk: Chunk) -> bool:
        """Check if minimum quorum of revealed votes is met."""
        revealed_count = sum(1 for v in chunk.votes.values() if v.revealed)
        return revealed_count >= self.q_min

    def decide(self, chunk: Chunk, current_round: int) -> ChunkState:
        """
        Apply decision rules to a chunk under review.
        Returns the new state after decision.
        """
        if chunk.state not in (ChunkState.UNDER_REVIEW, ChunkState.DISPUTED):
            return chunk.state

        # Reveal votes if in commit-reveal mode
        if self.commit_reveal:
            self.reveal_votes(chunk)

        if not self.check_quorum(chunk):
            # Not enough votes -- stays in current state (timeout handled externally)
            return chunk.state

        score = self.compute_vote_score(chunk)

        if score >= self.tau_accept:
            chunk.state = ChunkState.ACTIVE
            chunk.decided_round = current_round
        elif score <= self.tau_reject:
            chunk.state = ChunkState.REJECTED
            chunk.decided_round = current_round
        else:
            # Indeterminate -- reject after timeout (simplified: reject now)
            chunk.state = ChunkState.REJECTED
            chunk.decided_round = current_round

        return chunk.state

    def can_dispute(self, chunk: Chunk, agent_id: int, current_round: int) -> bool:
        """Check if an agent can dispute a chunk."""
        # Only active chunks can be disputed
        if chunk.state != ChunkState.ACTIVE:
            return False
        # Max disputes per chunk
        if chunk.dispute_count >= self.d_max_per_chunk:
            return False
        # Agent must be Tier 2
        if self.reputation.get_tier(agent_id) < 2:
            return False
        # Agent reputation must be above dispute minimum
        if self.reputation.get_local_reputation(agent_id) < self.r_dispute_min:
            return False
        # Rate limit per agent per window
        history = self.dispute_history.get(agent_id, [])
        recent = [r for r in history if current_round - r <= self.dispute_window]
        if len(recent) >= self.d_agent_per_window:
            return False

        return True

    def dispute(self, chunk: Chunk, agent_id: int, current_round: int) -> bool:
        """
        Initiate a dispute on an active chunk.
        Returns True if dispute was accepted.
        """
        if not self.can_dispute(chunk, agent_id, current_round):
            return False

        chunk.state = ChunkState.DISPUTED
        chunk.dispute_count += 1
        chunk.votes.clear()  # Reset votes for re-review
        chunk.decided_round = None

        # Record dispute
        if agent_id not in self.dispute_history:
            self.dispute_history[agent_id] = []
        self.dispute_history[agent_id].append(current_round)

        return True

    def get_deliberation_agents(self, chunk: Chunk) -> List[int]:
        """Get agents who submitted deliberation arguments."""
        return [
            v.agent_id for v in chunk.votes.values()
            if v.has_argument and v.revealed
        ]

    def get_chunks_in_state(self, state: ChunkState) -> List[Chunk]:
        """Get all chunks in a given state."""
        return [c for c in self.chunks.values() if c.state == state]

    def get_terminal_chunks(self) -> List[Chunk]:
        """Get all chunks that have reached a terminal state."""
        return [c for c in self.chunks.values() if c.state in TERMINAL_STATES]

    def get_active_chunks(self) -> List[Chunk]:
        """Get all chunks in ACTIVE state."""
        return self.get_chunks_in_state(ChunkState.ACTIVE)
