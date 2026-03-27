"""
Agent archetypes for the Deliberative Curation Protocol simulation.

Six archetypes with distinct voting strategies, contribution quality
distributions, and behavioral patterns.
"""

import numpy as np
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from enum import Enum


class AgentType(Enum):
    HONEST = "honest"
    LAZY = "lazy"
    MALICIOUS = "malicious"
    BROKEN = "broken"
    STRATEGIC = "strategic"
    SYCOPHANT = "sycophant"
    ADAPTIVE = "adaptive"


@dataclass
class Agent:
    """An agent participating in the curation protocol."""
    agent_id: int
    agent_type: AgentType
    is_quarantined: bool = False
    is_banned: bool = False
    review_suspended: bool = False
    contribution_suspended: bool = False
    rate_limited: bool = False
    probation: bool = False
    # Strategic agent state
    gaming_mode: bool = False
    # Adaptive agent state
    adaptive_phase: int = 1  # 1=building, 2=exploiting, 3=evading
    adaptive_honest_rounds: int = 0  # Rounds spent being honest in evasion phase


def create_agents(config: dict, rng: np.random.Generator) -> List[Agent]:
    """
    Create the agent population according to archetype distribution.
    Returns a list of Agent objects with sequential IDs.
    """
    n = config["n_agents"]
    archetypes = config["archetypes"]
    agents = []

    # Build ordered list of (type, count) ensuring we hit exactly n agents
    type_counts = []
    remaining = n
    for i, (type_name, fraction) in enumerate(archetypes.items()):
        if i == len(archetypes) - 1:
            count = remaining  # Last type gets the remainder
        else:
            count = round(n * fraction)
            remaining -= count
        type_counts.append((AgentType(type_name), count))

    agent_id = 0
    for agent_type, count in type_counts:
        for _ in range(count):
            agents.append(Agent(agent_id=agent_id, agent_type=agent_type))
            agent_id += 1

    # Shuffle so archetypes are not grouped by ID
    rng.shuffle(agents)
    # Reassign IDs after shuffle
    for i, agent in enumerate(agents):
        agent.agent_id = i

    return agents


def generate_chunk_quality(agent: Agent, rng: np.random.Generator) -> float:
    """
    Generate a chunk quality value based on agent archetype.
    Returns a float in [0, 1] representing ground-truth quality.
    """
    if agent.agent_type == AgentType.HONEST:
        return rng.beta(8, 2)
    elif agent.agent_type == AgentType.LAZY:
        return rng.uniform(0, 1)
    elif agent.agent_type == AgentType.MALICIOUS:
        return rng.beta(2, 8)
    elif agent.agent_type == AgentType.BROKEN:
        return rng.beta(5, 3)
    elif agent.agent_type == AgentType.STRATEGIC:
        return rng.beta(5, 5)
    elif agent.agent_type == AgentType.SYCOPHANT:
        return rng.beta(6, 3)
    elif agent.agent_type == AgentType.ADAPTIVE:
        # Good quality in building/evasion phases, bad in exploitation
        if agent.adaptive_phase in (1, 3):
            return rng.beta(8, 2)  # Same as honest
        else:
            return rng.beta(2, 8)  # Same as malicious
    else:
        return rng.uniform(0, 1)


def vote(agent: Agent, chunk_quality: float, rng: np.random.Generator,
         reputation_system=None, chunk=None,
         commit_reveal: bool = True) -> int:
    """
    Determine an agent's vote on a chunk based on its archetype.

    Args:
        agent: The voting agent
        chunk_quality: Ground-truth quality of the chunk
        rng: Random number generator
        reputation_system: ReputationSystem (needed for sycophant)
        chunk: Chunk object (needed for sycophant to see existing votes)
        commit_reveal: Whether commit-reveal is enabled

    Returns:
        +1 (approve), -1 (reject), or 0 (abstain)
    """
    if agent.agent_type == AgentType.HONEST:
        return _vote_honest(chunk_quality)

    elif agent.agent_type == AgentType.LAZY:
        return 1  # Rubber stamp

    elif agent.agent_type == AgentType.MALICIOUS:
        return _vote_malicious(chunk_quality)

    elif agent.agent_type == AgentType.BROKEN:
        # 5% chance of crashing (skipping)
        if rng.random() < 0.05:
            return 0  # Skip
        # 70% correct, 30% random
        if rng.random() < 0.7:
            return _vote_honest(chunk_quality)
        else:
            return rng.choice([-1, 0, 1])

    elif agent.agent_type == AgentType.STRATEGIC:
        return _vote_strategic(agent, chunk_quality, reputation_system, rng)

    elif agent.agent_type == AgentType.SYCOPHANT:
        return _vote_sycophant(agent, chunk, reputation_system, commit_reveal, rng)

    elif agent.agent_type == AgentType.ADAPTIVE:
        return _vote_adaptive(agent, chunk_quality, reputation_system, rng)

    return 0


def _vote_honest(quality: float) -> int:
    """Honest voting: approve good, reject bad, abstain on mediocre."""
    if quality >= 0.65:
        return 1
    elif quality < 0.35:
        return -1
    return 0


def _vote_malicious(quality: float) -> int:
    """
    Malicious voting: approve bad, reject good.
    Farm reputation on mediocre chunks by voting honestly.
    """
    if quality < 0.3:
        return 1   # Approve bad
    elif quality >= 0.7:
        return -1   # Reject good
    else:
        # Farm reputation on mediocre -- vote honestly
        return _vote_honest(quality)


def _vote_strategic(agent: Agent, quality: float,
                    reputation_system, rng: np.random.Generator) -> int:
    """
    Strategic voting: honest until Tier 2, then start gaming.
    Monitor reputation and back off if declining.
    """
    if reputation_system is None:
        return _vote_honest(quality)

    tier = reputation_system.get_tier(agent.agent_id)
    r = reputation_system.get_local_reputation(agent.agent_id)

    if tier < 2 or not agent.gaming_mode:
        # Check if we should enter gaming mode
        if tier >= 2:
            agent.gaming_mode = True
        return _vote_honest(quality)

    # In gaming mode: back off if reputation is declining
    if r < 0.5:
        agent.gaming_mode = False
        return _vote_honest(quality)

    # Gaming: approve borderline bad chunks (0.2-0.4), suppress borderline good (0.5-0.65)
    if 0.2 <= quality <= 0.4:
        return 1 if rng.random() < 0.6 else _vote_honest(quality)
    elif 0.5 <= quality <= 0.65:
        return -1 if rng.random() < 0.4 else _vote_honest(quality)
    else:
        return _vote_honest(quality)


def _vote_sycophant(agent: Agent, chunk, reputation_system,
                    commit_reveal: bool, rng: np.random.Generator) -> int:
    """
    Sycophant voting: defer to authority.
    If commit-reveal is ON: can't see votes, so judge by contributor reputation.
      - High-rep contributor (top 30%): approve.
      - Low-rep contributor (bottom 30%): reject.
      - Otherwise: approve with 70% probability.
    If commit-reveal is OFF: copy visible majority.
    """
    if chunk is None or reputation_system is None:
        return 1  # Default approve

    if commit_reveal:
        # Defer-to-authority heuristic based on contributor reputation
        all_reps = sorted(
            reputation_system.get_local_reputation(aid)
            for aid in reputation_system.states
        )
        n = len(all_reps)
        if n == 0:
            return 1
        low_threshold = all_reps[int(n * 0.3)]
        high_threshold = all_reps[int(n * 0.7)]
        contributor_rep = reputation_system.get_local_reputation(chunk.contributor_id)
        if contributor_rep >= high_threshold:
            return 1
        elif contributor_rep <= low_threshold:
            return -1
        else:
            return 1 if rng.random() < 0.7 else -1
    else:
        # Copy majority of revealed votes
        revealed_votes = [v.value for v in chunk.votes.values() if v.revealed and v.value != 0]
        if not revealed_votes:
            return 1
        total = sum(revealed_votes)
        if total > 0:
            return 1
        elif total < 0:
            return -1
        else:
            return 1  # Tie-break: approve


def _vote_adaptive(agent: Agent, quality: float,
                    reputation_system, rng: np.random.Generator) -> int:
    """
    Adaptive adversary: build trust, exploit it, evade detection.

    Phase 1 (building): act honest for first 100 rounds (tracked via
        reputation — stay in phase 1 until reaching Tier 2).
    Phase 2 (exploitation): once reputation >= r2 threshold, behave maliciously.
    Phase 3 (evasion): if reputation drops below r1, revert to honest for 20
        rounds then try exploitation again.
    """
    if reputation_system is None:
        return _vote_honest(quality)

    r = reputation_system.get_local_reputation(agent.agent_id)
    tier = reputation_system.get_tier(agent.agent_id)

    if agent.adaptive_phase == 1:
        # Building phase: act honest until Tier 2
        if tier >= 2:
            agent.adaptive_phase = 2
            return _vote_malicious(quality)
        return _vote_honest(quality)

    elif agent.adaptive_phase == 2:
        # Exploitation phase: behave maliciously
        r1 = reputation_system.tier_thresholds[1]
        if r < r1:
            # Reputation dropped too low, switch to evasion
            agent.adaptive_phase = 3
            agent.adaptive_honest_rounds = 0
            return _vote_honest(quality)
        return _vote_malicious(quality)

    else:  # Phase 3: evasion
        agent.adaptive_honest_rounds += 1
        if agent.adaptive_honest_rounds >= 20:
            # Try exploitation again
            agent.adaptive_phase = 2
            return _vote_malicious(quality)
        return _vote_honest(quality)


def should_submit_argument(agent: Agent, rng: np.random.Generator) -> bool:
    """
    Determine if an agent submits a deliberation argument.
    Honest and strategic agents are more likely to deliberate.
    """
    probabilities = {
        AgentType.HONEST: 0.4,
        AgentType.LAZY: 0.05,
        AgentType.MALICIOUS: 0.15,
        AgentType.BROKEN: 0.2,
        AgentType.STRATEGIC: 0.35,
        AgentType.SYCOPHANT: 0.1,
        AgentType.ADAPTIVE: 0.3,
    }
    return rng.random() < probabilities.get(agent.agent_type, 0.1)


def should_contribute_duplicate(agent: Agent, rng: np.random.Generator) -> bool:
    """Check if a broken agent submits a duplicate (10% chance)."""
    if agent.agent_type == AgentType.BROKEN:
        return rng.random() < 0.1
    return False
