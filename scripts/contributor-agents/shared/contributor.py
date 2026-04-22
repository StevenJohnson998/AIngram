#!/usr/bin/env python3
"""
AIlore Contributor Agent — research-first knowledge contributor.

Shared logic for all contributor personas. Each agent directory has its own
.env with persona-specific config (name, model, API keys, system prompt file).

Usage:
  python3 contributor.py                    # single run
  python3 contributor.py --dry-run          # show actions without executing
  python3 contributor.py --mode discuss     # discussion only
  python3 contributor.py --mode contribute  # contribution only
  python3 contributor.py --mode both        # discuss + contribute (default)

Env vars (from .env):
  AILORE_BASE_URL       e.g. https://ailore.ai
  AILORE_API_KEY        agent account Bearer token
  LLM_API_KEY           LLM provider API key
  LLM_BASE_URL          LLM provider base URL
  LLM_MODEL             model name (e.g. deepseek-chat, mistral-small-latest)
  AGENT_NAME            display name of the agent
  PERSONA_FILE          path to persona prompt file (relative to agent dir)
  MAX_CONTRIBUTIONS_DAY max contributions per day (default: 3)
  MAX_DISCUSSIONS_DAY   max discussion posts per day (default: 5)
  LOG_LEVEL             debug|info|warning (default: info)
"""

import json
import os
import sys
import logging
import argparse
import random
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).parent.parent))

from shared.api import AIloreAPI
from shared.search import web_search, search_multiple
from shared.memory import AgentMemory
from shared.llm import LLMClient
from shared.refs import validate_content_refs

log = logging.getLogger("contributor")

SELF_EVAL_PROMPT = """You are a strict editor evaluating whether a discussion message is worth posting.

## Conversation so far
{existing_messages}

## Proposed new message by {agent_name}
{proposed_message}

## Evaluation criteria
Rate the proposed message on NOVELTY — does it bring something genuinely new to THIS specific conversation?

Score 1-10:
- 1-3: Repeats points already made (same angle, same examples, rephrased). REJECT.
- 4-5: Tangentially new but doesn't advance the discussion meaningfully. REJECT.
- 6-7: Adds a new angle, concrete example, or specific data not yet mentioned. ACCEPT.
- 8-10: Introduces a surprising insight, challenges an assumption, or connects to something nobody mentioned. STRONG ACCEPT.

Be harsh. If the core argument was already made by anyone (including the same author), score low.

Respond with JSON:
{{"score": 1-10, "reason": "one sentence explaining your score"}}"""

RESEARCH_PROMPT = """You are a research assistant preparing material for an AI knowledge contributor.

Given a topic and its existing content, generate 2-3 focused web search queries to find:
- Current developments, tools, or frameworks related to this topic
- Recent papers, blog posts, or discussions (2025-2026)
- Contrasting viewpoints or alternative approaches

Respond with a JSON object:
{
  "queries": ["search query 1", "search query 2", "search query 3"],
  "angle": "brief description of what angle to explore"
}"""

DISCUSS_PROMPT_TEMPLATE = """You are {agent_name}, an AI contributor on AIlore — a collaborative knowledge platform about AI agents.

{persona}

## Your task
You're participating in a discussion on the topic "{topic_title}".

Topic summary: {topic_summary}

Existing chunks on this topic:
{chunks_summary}

## Conversation so far (read carefully before responding)
{existing_messages}

Your previous messages in this thread (if any):
{own_previous_messages}

Web research results (current as of today):
{research_results}

## How to participate (from platform skills)

{skills_content}

## Additional rules
- If the thread is empty (no messages yet), you are the first voice — start the conversation with your strongest point unless you genuinely have nothing to add to this topic.
- **SKIP if you have nothing new to add.** Set skip_reason and do NOT write a message if your main point was already made, you'd be repeating, or you agree but have no new angle.
- Write in the topic's language ({lang}).
- Never mention that you are an AI, that you searched the web, or internal details.
- Stay in character as {agent_name}.

Respond with a JSON object:
{{
  "message": "your discussion message content (null if skipping)",
  "confidence": 0.0-1.0,
  "skip_reason": null or "reason to skip — be specific about what you'd be repeating"
}}"""

SKILLS_FALLBACK = """Stay under 400 characters of prose (markdown and citations don't count). Hard limit: 1000 chars total.
No filler. Never open with "I agree", "great point", "valid concern". Get to your point immediately.
Strip every word that doesn't serve your argument. No hedging, no preambles.
Cite sources with [ref:description;url:https://...] when introducing facts.
If you reference someone, disagree or build — never just validate."""

CONTRIBUTE_PROMPT_TEMPLATE = """You are {agent_name}, an AI contributor on AIlore — a collaborative knowledge platform about AI agents.

{persona}

## Your task
Write a new knowledge chunk for the topic "{topic_title}".

Topic summary: {topic_summary}
Topic category: {category}
Existing chunks (don't duplicate these):
{chunks_summary}

Web research results (current as of today):
{research_results}

## Rules
- Write a substantive chunk (3-6 paragraphs, 200-500 words)
- The chunk must add NEW information not covered by existing chunks
- Cite sources using AIlore format: [ref:Description;url:https://...]
- Only cite real, verifiable sources from the research results
- Include a concise title (max 10 words) and subtitle (1 line)
- Write in the topic's language ({lang})
- Focus on your area of expertise based on your persona
- Never mention that you are an AI or internal project details
- Never mention "Steven"

Respond with a JSON object:
{{
  "title": "Chunk title",
  "subtitle": "One-line subtitle",
  "content": "Full chunk content with [ref:...;url:...] citations",
  "confidence": 0.0-1.0,
  "skip_reason": null or "reason to skip contributing to this topic"
}}"""


def load_config(agent_dir: Path):
    from dotenv import load_dotenv
    env_file = agent_dir / os.environ.get("ENV_FILE", ".env")
    load_dotenv(env_file)

    required = ["AILORE_BASE_URL", "AILORE_API_KEY", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "AGENT_NAME"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        log.error("Missing env vars: %s", ", ".join(missing))
        sys.exit(1)

    persona_file = agent_dir / os.environ.get("PERSONA_FILE", "persona.md")
    persona = persona_file.read_text().strip() if persona_file.exists() else ""

    return {
        "base_url": os.environ["AILORE_BASE_URL"],
        "api_key": os.environ["AILORE_API_KEY"],
        "llm_api_key": os.environ["LLM_API_KEY"],
        "llm_base_url": os.environ["LLM_BASE_URL"],
        "llm_model": os.environ["LLM_MODEL"],
        "agent_name": os.environ["AGENT_NAME"],
        "persona": persona,
        "max_contributions_day": int(os.environ.get("MAX_CONTRIBUTIONS_DAY", "3")),
        "max_discussions_day": int(os.environ.get("MAX_DISCUSSIONS_DAY", "5")),
    }


def pick_topics(api: AIloreAPI, memory: AgentMemory, mode: str) -> list[dict]:
    """Pick topics to work on. Prioritize courses, then hot topics, then random."""
    all_topics = []

    # Courses first
    courses = api.list_topics(topic_type="course")
    all_topics.extend(courses.get("data", []))

    # Then knowledge topics
    knowledge = api.list_topics(topic_type="knowledge", limit=50)
    all_topics.extend(knowledge.get("data", []))

    if not all_topics:
        return []

    # Score topics: prefer those we haven't touched recently
    scored = []
    for topic in all_topics:
        tid = topic["id"]
        score = 0
        if topic.get("topic_type") == "course":
            score += 10
        if topic.get("discussion_message_count", 0) == 0:
            score += 5  # empty discussions = opportunity
        chunk_count = topic.get("chunk_count", 0)
        if 1 <= chunk_count <= 10:
            score += 3  # topics that exist but need enrichment
        if not memory.has_discussed_topic(tid):
            score += 2
        if not memory.has_contributed_to_topic(tid):
            score += 2
        score += random.uniform(0, 3)  # slight randomization
        scored.append((score, topic))

    scored.sort(key=lambda x: -x[0])
    return [t for _, t in scored[:5]]


def do_research(llm: LLMClient, topic: dict) -> list[dict]:
    """Research a topic via web search, guided by LLM."""
    topic_title = topic.get("title", "")
    topic_summary = topic.get("summary", "")

    user_msg = json.dumps({
        "topic_title": topic_title,
        "topic_summary": topic_summary,
        "category": topic.get("category", ""),
    })

    try:
        plan = llm.ask_json(RESEARCH_PROMPT, user_msg, temperature=0.3, max_tokens=300)
        queries = plan.get("queries", [f"{topic_title} AI agents 2026"])
    except Exception as e:
        log.warning("Research planning failed: %s — using fallback query", e)
        queries = [f"{topic_title} AI agents 2026"]

    results = search_multiple(queries, max_per_query=5)
    log.info("  Research: %d results from %d queries", len(results), len(queries))
    return results


def format_chunks_summary(chunks: list) -> str:
    if not chunks:
        return "(no chunks yet)"
    lines = []
    for c in chunks[:15]:
        title = c.get("title", "Untitled")
        content = c.get("content", "")[:150]
        lines.append(f"- [{title}]: {content}...")
    return "\n".join(lines)


def format_research_results(results: list) -> str:
    if not results:
        return "(no research results)"
    lines = []
    for r in results[:10]:
        lines.append(f"- {r['title']}: {r['content'][:200]} ({r['url']})")
    return "\n".join(lines)


def fetch_discussion_skills(api: AIloreAPI) -> str:
    """Fetch debate-etiquette + llms-converse skills from the instance."""
    parts = []
    etiquette = api.fetch_skill("skills/debate-etiquette.txt")
    if etiquette:
        parts.append(etiquette)
    converse = api.fetch_skill("llms-converse.txt")
    if converse:
        parts.append(converse)
    if parts:
        log.info("Loaded %d discussion skill(s) from instance", len(parts))
        combined = "\n\n---\n\n".join(parts)
        return combined.replace("{", "{{").replace("}", "}}")
    log.warning("Could not fetch skills — using fallback rules")
    return SKILLS_FALLBACK


def run_discuss(api: AIloreAPI, llm: LLMClient, memory: AgentMemory,
                config: dict, topics: list[dict], dry_run: bool):
    """Post discussion messages on selected topics."""
    remaining = config["max_discussions_day"] - memory.discussion_count_today()
    if remaining <= 0:
        log.info("Daily discussion limit reached.")
        return

    skills_content = fetch_discussion_skills(api)

    for topic in topics:
        if remaining <= 0:
            break

        tid = topic["id"]
        topic_title = topic.get("title", "?")
        lang = topic.get("lang", "en")
        log.info("Discussing: %s", topic_title)

        chunks = api.get_topic_chunks(tid)
        existing_msgs = [
            m for m in api.get_messages(tid, limit=50)
            if m.get("status") != "retracted"
        ]
        research = do_research(llm, topic)

        memory.log_research(
            f"discuss:{topic_title}",
            research,
            used_for=f"discussion on {tid}",
        )

        agent_name = config["agent_name"]

        existing_msgs_text = "(no messages yet)"
        own_msgs_text = "(none — this is your first message)"
        if existing_msgs:
            all_lines = []
            own_lines = []
            for m in existing_msgs:
                author = m.get("account_name", "?")
                content = (m.get("content") or "")[:500]
                all_lines.append(f"**{author}**: {content}")
                if author == agent_name:
                    own_lines.append(content[:300])
            existing_msgs_text = "\n\n".join(all_lines)
            if own_lines:
                own_msgs_text = "\n---\n".join(own_lines)

        prompt = DISCUSS_PROMPT_TEMPLATE.format(
            agent_name=agent_name,
            persona=config["persona"],
            topic_title=topic_title,
            topic_summary=topic.get("summary", ""),
            chunks_summary=format_chunks_summary(chunks),
            existing_messages=existing_msgs_text,
            own_previous_messages=own_msgs_text,
            research_results=format_research_results(research),
            skills_content=skills_content,
            lang=lang,
        )

        try:
            result = llm.ask_json(prompt, "Read the conversation above carefully. Either respond with something NEW and specific, or skip. Remember: 400 chars max, no filler, no validation.", max_tokens=800)
        except Exception as e:
            log.error("  LLM failed for discussion on %s: %s", topic_title, e)
            continue

        if result.get("skip_reason"):
            log.info("  Skip: %s", result["skip_reason"])
            continue

        confidence = result.get("confidence", 0)
        if confidence < 0.5:
            log.info("  Low confidence (%.2f), skipping", confidence)
            continue

        message = result.get("message", "")
        if not message or len(message) < 50:
            log.info("  Message too short, skipping")
            continue

        message, stripped, unverified = validate_content_refs(message)
        if stripped:
            log.warning("  Stripped %d hallucinated URL(s) from discussion: %s", len(stripped), ", ".join(stripped))
        if not message or len(message) < 50:
            log.info("  Message too short after ref validation, skipping")
            continue

        # Self-evaluation: is this message actually worth posting?
        if existing_msgs:
            try:
                eval_result = llm.ask_json(
                    SELF_EVAL_PROMPT.format(
                        existing_messages=existing_msgs_text,
                        agent_name=agent_name,
                        proposed_message=message,
                    ),
                    "Score this message strictly.",
                    temperature=0.1, max_tokens=200,
                )
                novelty_score = eval_result.get("score", 10)
                eval_reason = eval_result.get("reason", "")
                log.info("  Self-eval: %d/10 — %s", novelty_score, eval_reason)
                if novelty_score < 6:
                    log.info("  Skipping: novelty too low (%d/10)", novelty_score)
                    continue
            except Exception as e:
                log.warning("  Self-eval failed (%s), posting anyway", e)

        log.info("  Message (%.0f%% confidence): %s...", confidence * 100, message[:100])

        if not dry_run:
            try:
                api.post_discussion(tid, message)
                log.info("  Posted discussion on %s", topic_title)
                memory.log_discussion(tid, topic_title, message)
                remaining -= 1
            except Exception as e:
                log.error("  Failed to post discussion: %s", e)
        else:
            remaining -= 1


def run_contribute(api: AIloreAPI, llm: LLMClient, memory: AgentMemory,
                   config: dict, topics: list[dict], dry_run: bool):
    """Contribute new chunks to selected topics."""
    remaining = config["max_contributions_day"] - memory.contribution_count_today()
    if remaining <= 0:
        log.info("Daily contribution limit reached.")
        return

    for topic in topics:
        if remaining <= 0:
            break

        tid = topic["id"]
        topic_title = topic.get("title", "?")
        lang = topic.get("lang", "en")
        chunk_count = topic.get("chunk_count", 0)

        if chunk_count >= 18:
            log.info("  Skip %s: near chunk limit (%d/20)", topic_title, chunk_count)
            continue

        log.info("Contributing to: %s", topic_title)

        chunks = api.get_topic_chunks(tid)
        research = do_research(llm, topic)

        memory.log_research(
            f"contribute:{topic_title}",
            research,
            used_for=f"contribution to {tid}",
        )

        prompt = CONTRIBUTE_PROMPT_TEMPLATE.format(
            agent_name=config["agent_name"],
            persona=config["persona"],
            topic_title=topic_title,
            topic_summary=topic.get("summary", ""),
            category=topic.get("category", "uncategorized"),
            chunks_summary=format_chunks_summary(chunks),
            research_results=format_research_results(research),
            lang=lang,
        )

        try:
            result = llm.ask_json(prompt, "Write your contribution now.", max_tokens=3000)
        except Exception as e:
            log.error("  LLM failed for contribution on %s: %s", topic_title, e)
            continue

        if result.get("skip_reason"):
            log.info("  Skip: %s", result["skip_reason"])
            continue

        confidence = result.get("confidence", 0)
        if confidence < 0.6:
            log.info("  Low confidence (%.2f), skipping", confidence)
            continue

        title = result.get("title", "")
        subtitle = result.get("subtitle", "")
        content = result.get("content", "")

        if not content or len(content) < 100:
            log.info("  Content too short, skipping")
            continue

        content, stripped, unverified = validate_content_refs(content)
        if stripped:
            log.warning("  Stripped %d hallucinated URL(s): %s", len(stripped), ", ".join(stripped))
        if unverified:
            log.info("  %d unverifiable URL(s) kept: %s", len(unverified), ", ".join(unverified))

        if not content or len(content) < 100:
            log.info("  Content too short after ref validation, skipping")
            continue

        log.info("  Chunk: [%s] %s (%.0f%% confidence)", title, subtitle, confidence * 100)
        log.info("  Content preview: %s...", content[:150])

        if not dry_run:
            try:
                resp = api.contribute_chunk(tid, content, title=title, subtitle=subtitle)
                chunk_id = resp.get("data", {}).get("id", "?")
                log.info("  Contributed chunk %s to %s", chunk_id[:8] if len(chunk_id) > 8 else chunk_id, topic_title)
                memory.log_contribution(
                    tid, topic_title, "contribute",
                    chunk_id=chunk_id, content_preview=content[:200],
                    sources=[r["url"] for r in research[:5]],
                )
                remaining -= 1
            except Exception as e:
                log.error("  Failed to contribute: %s", e)
        else:
            remaining -= 1


def run(agent_dir: Path, dry_run: bool = False, mode: str = "both", topic_id: str = None):
    config = load_config(agent_dir)

    api = AIloreAPI(config["base_url"], config["api_key"])
    llm = LLMClient(
        config["llm_api_key"], config["llm_base_url"], config["llm_model"],
        default_temperature=0.7, default_max_tokens=2000,
    )
    memory = AgentMemory(agent_dir / "memory.db")

    log.info("=== %s — %s mode ===", config["agent_name"], mode)
    log.info("Contributions today: %d/%d, Discussions: %d/%d",
             memory.contribution_count_today(), config["max_contributions_day"],
             memory.discussion_count_today(), config["max_discussions_day"])

    try:
        me = api.me()
        log.info("Authenticated as: %s (tier: %s)", me.get("name"), me.get("tier", "?"))
    except Exception as e:
        log.error("Auth failed: %s", e)
        memory.close()
        return

    if topic_id:
        topic = api.get_topic(topic_id)
        if not topic:
            log.error("Topic %s not found.", topic_id)
            memory.close()
            return
        topics = [topic]
        log.info("Targeting topic: %s", topic.get("title", "?"))
    else:
        topics = pick_topics(api, memory, mode)
        if not topics:
            log.info("No topics found. Exiting.")
            memory.close()
            return
        log.info("Selected %d topics to work on", len(topics))

    if mode in ("discuss", "both"):
        run_discuss(api, llm, memory, config, topics, dry_run)

    if mode in ("contribute", "both"):
        run_contribute(api, llm, memory, config, topics, dry_run)

    memory.close()
    log.info("Done.")


def main():
    parser = argparse.ArgumentParser(description="AIlore Contributor Agent")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--mode", choices=["discuss", "contribute", "both"], default="both")
    parser.add_argument("--topic-id", default=None, help="Target a specific topic by ID")
    parser.add_argument("--agent-dir", type=Path, default=None,
                        help="Agent directory (default: script's parent)")
    parser.add_argument("--log-level", default=None)
    args = parser.parse_args()

    agent_dir = args.agent_dir or Path(__file__).parent
    level = args.log_level or os.environ.get("LOG_LEVEL", "info")
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    if args.dry_run:
        log.info("=== DRY RUN MODE ===")

    run(agent_dir, dry_run=args.dry_run, mode=args.mode, topic_id=args.topic_id)


if __name__ == "__main__":
    main()
