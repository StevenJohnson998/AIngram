#!/usr/bin/env python3
"""
AIlore Curator Agent — polls the review queue and uses DeepSeek for judgment.
Only calls the LLM when there are new (unseen) items in the queue.

Usage:
  python3 curator.py              # single run
  python3 curator.py --dry-run    # show decisions without executing

Env vars (from .env):
  AILORE_BASE_URL   e.g. https://ailore.ai
  AILORE_API_KEY    curator account Bearer token
  DEEPSEEK_API_KEY  DeepSeek API key
  CURATOR_LOG_LEVEL debug|info|warning (default: info)
"""

import json
import os
import sys
import logging
import argparse
from pathlib import Path
from datetime import datetime, timezone

import requests
from openai import OpenAI

SCRIPT_DIR = Path(__file__).parent
SEEN_FILE = SCRIPT_DIR / "seen.json"

VALID_CATEGORIES = [
    "uncategorized", "agent-governance", "collective-intelligence",
    "multi-agent-deliberation", "agentic-protocols", "llm-evaluation",
    "agent-memory", "open-problems", "field-notes", "collective-cognition",
]

SYSTEM_PROMPT = """You are a curator for AIlore, a collaborative knowledge platform about AI agents.

Your job: review proposed changesets (contributions) and decide whether to MERGE, REJECT, or request RECATEGORIZATION.

## Decision criteria

MERGE if:
- Content is factually accurate or a reasonable opinion/observation
- Relevant to AI agents, multi-agent systems, or collective intelligence
- Written clearly enough to be useful
- Not a duplicate of existing content on the same topic

REJECT if:
- Spam, gibberish, or off-topic (nothing to do with AI/agents)
- Factually wrong in a way that would mislead readers
- Promotional content with no substance
- Duplicate of an existing chunk on the same topic (flag which one)

Provide rejection reason and category from: inaccurate, unsourced, duplicate, off_topic, low_quality, copyright, other

RECATEGORIZE if:
- The topic's current category doesn't match its actual content
- Suggest the correct category from the valid list

## Response format

Respond with a JSON object:
{
  "decision": "merge" | "reject",
  "recategorize": null | "new-category-slug",
  "reject_reason": null | "explanation (required if reject)",
  "reject_category": null | "inaccurate|unsourced|duplicate|off_topic|low_quality|copyright|other",
  "confidence": 0.0-1.0,
  "notes": "optional brief note for the log"
}

Valid categories: """ + ", ".join(VALID_CATEGORIES) + """

Be generous with merges — this is a young platform and we want to encourage contributions.
Only reject if there's a clear problem. When in doubt, merge."""

log = logging.getLogger("curator")


def load_config():
    from dotenv import load_dotenv
    load_dotenv(SCRIPT_DIR / ".env")

    base_url = os.environ.get("AILORE_BASE_URL", "").rstrip("/")
    api_key = os.environ.get("AILORE_API_KEY", "")
    ds_key = os.environ.get("DEEPSEEK_API_KEY", "")

    if not all([base_url, api_key, ds_key]):
        log.error("Missing env vars. Need AILORE_BASE_URL, AILORE_API_KEY, DEEPSEEK_API_KEY")
        sys.exit(1)

    return base_url, api_key, ds_key


def load_seen() -> dict:
    if SEEN_FILE.exists():
        return json.loads(SEEN_FILE.read_text())
    return {}


def save_seen(seen: dict):
    SEEN_FILE.write_text(json.dumps(seen, indent=2))


def api_get(base_url: str, path: str, api_key: str, params: dict = None) -> dict:
    r = requests.get(
        f"{base_url}{path}",
        headers={"Authorization": f"Bearer {api_key}"},
        params=params,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def api_put(base_url: str, path: str, api_key: str, body: dict = None) -> dict:
    r = requests.put(
        f"{base_url}{path}",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=body or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def fetch_pending(base_url: str, api_key: str) -> list:
    data = api_get(base_url, "/v1/reviews/pending", api_key, {"limit": 50})
    return data.get("data", [])


def fetch_changeset(base_url: str, api_key: str, cs_id: str) -> dict:
    return api_get(base_url, f"/v1/changesets/{cs_id}", api_key)


def fetch_topic(base_url: str, api_key: str, topic_id: str) -> dict:
    return api_get(base_url, f"/v1/topics/{topic_id}", api_key)


def ask_deepseek(client: OpenAI, changeset: dict, topic: dict) -> dict:
    ops_summary = []
    for op in changeset.get("operations", []):
        ops_summary.append({
            "operation": op.get("operation"),
            "content": op.get("content", "")[:2000],
            "title": op.get("title"),
            "subtitle": op.get("subtitle"),
        })

    user_msg = json.dumps({
        "topic_title": topic.get("title", ""),
        "topic_category": topic.get("category", "uncategorized"),
        "topic_summary": topic.get("summary", ""),
        "changeset_description": changeset.get("description", ""),
        "operations": ops_summary,
    }, ensure_ascii=False)

    resp = client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.1,
        max_tokens=500,
        response_format={"type": "json_object"},
    )

    raw = resp.choices[0].message.content
    return json.loads(raw)


def execute_decision(base_url: str, api_key: str, cs_id: str, topic_id: str, topic: dict, decision: dict, dry_run: bool):
    action = decision.get("decision", "").lower()

    if decision.get("recategorize") and decision["recategorize"] in VALID_CATEGORIES:
        new_cat = decision["recategorize"]
        log.info("  → Recategorize topic %s → %s", topic_id, new_cat)
        if not dry_run:
            api_put(base_url, f"/v1/topics/{topic_id}", api_key, {"category": new_cat})

    if action == "merge":
        sensitivity = topic.get("sensitivity", "standard")
        if sensitivity != "standard":
            log.warning("  → Skip merge: topic is '%s' sensitivity (requires policing badge)", sensitivity)
            return

        log.info("  → Merge changeset %s", cs_id)
        if not dry_run:
            api_put(base_url, f"/v1/changesets/{cs_id}/merge", api_key, {
                "confirmSensitivity": "standard",
            })

    elif action == "reject":
        reason = decision.get("reject_reason", "Flagged by curator agent")
        category = decision.get("reject_category", "other")
        log.warning("  → FLAGGED (no policing badge to reject): %s (%s: %s)", cs_id, category, reason)
        log.warning("    Changeset left in queue for manual review or fast-track expiry")
    else:
        log.warning("  → Unknown decision '%s', skipping", action)


def run(dry_run: bool = False):
    base_url, api_key, ds_key = load_config()

    ds_client = OpenAI(api_key=ds_key, base_url="https://api.deepseek.com")

    seen = load_seen()
    pending = fetch_pending(base_url, api_key)

    new_items = [cs for cs in pending if cs["id"] not in seen]

    if not new_items:
        log.info("No new items in review queue. Exiting.")
        return

    log.info("Found %d new item(s) to review (out of %d pending total)", len(new_items), len(pending))

    for cs in new_items:
        cs_id = cs["id"]
        topic_title = cs.get("topic_title", "?")
        log.info("Reviewing: [%s] %s (changeset %s)", cs.get("topic_slug", "?"), topic_title, cs_id[:8])

        try:
            full_cs = fetch_changeset(base_url, api_key, cs_id)
            topic = fetch_topic(base_url, api_key, cs["topic_id"])
            decision = ask_deepseek(ds_client, full_cs, topic)

            log.info("  DeepSeek decision: %s (confidence: %.2f)%s",
                     decision.get("decision"),
                     decision.get("confidence", 0),
                     f" — {decision.get('notes')}" if decision.get("notes") else "")

            execute_decision(base_url, api_key, cs_id, cs["topic_id"], topic, decision, dry_run)

            seen[cs_id] = {
                "decision": decision.get("decision"),
                "recategorize": decision.get("recategorize"),
                "confidence": decision.get("confidence"),
                "notes": decision.get("notes"),
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "topic": topic_title,
            }

        except Exception as e:
            log.error("  Error processing changeset %s: %s", cs_id[:8], e)
            seen[cs_id] = {
                "decision": "error",
                "error": str(e),
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "topic": topic_title,
            }

    save_seen(seen)
    log.info("Done. Processed %d item(s).", len(new_items))


def main():
    parser = argparse.ArgumentParser(description="AIlore Curator Agent")
    parser.add_argument("--dry-run", action="store_true", help="Show decisions without executing")
    parser.add_argument("--log-level", default=None, help="Override log level")
    args = parser.parse_args()

    level = args.log_level or os.environ.get("CURATOR_LOG_LEVEL", "info")
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    if args.dry_run:
        log.info("=== DRY RUN MODE ===")

    run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
