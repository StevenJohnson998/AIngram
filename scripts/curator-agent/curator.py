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
IMPROVED_FILE = SCRIPT_DIR / "improved.json"

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

## Links & citations audit

Flag problems with internal links and citations in the content:
- Broken citation: [ref:...] with a dead URL or no URL at all when one clearly exists
- Hallucinated citation: [ref:...] citing a paper/source that doesn't exist or has wrong author/title
- Broken internal link: [[slug]] pointing to a topic that doesn't exist on the platform
- Malformed syntax: unclosed [ref:] or [[]] brackets

Report issues in the "link_issues" field. Do NOT reject solely for link issues — merge and flag them for correction.

## Response format

Respond with a JSON object:
{
  "decision": "merge" | "reject",
  "recategorize": null | "new-category-slug",
  "reject_reason": null | "explanation (required if reject)",
  "reject_category": null | "inaccurate|unsourced|duplicate|off_topic|low_quality|copyright|other",
  "link_issues": null | ["description of each issue"],
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


def api_post(base_url: str, path: str, api_key: str, body: dict = None) -> dict:
    r = requests.post(
        f"{base_url}{path}",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=body or {},
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
    resp = api_get(base_url, f"/v1/changesets/{cs_id}", api_key)
    return resp.get("data", resp)


def fetch_topic(base_url: str, api_key: str, topic_id: str) -> dict:
    resp = api_get(base_url, f"/v1/topics/{topic_id}", api_key)
    return resp.get("data", resp)


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

            link_issues = decision.get("link_issues")
            if link_issues:
                for issue in link_issues:
                    log.warning("  ⚠ Link/citation issue: %s", issue)

            execute_decision(base_url, api_key, cs_id, cs["topic_id"], topic, decision, dry_run)

            seen[cs_id] = {
                "decision": decision.get("decision"),
                "recategorize": decision.get("recategorize"),
                "confidence": decision.get("confidence"),
                "notes": decision.get("notes"),
                "link_issues": decision.get("link_issues"),
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

    if not dry_run:
        save_seen(seen)
    log.info("Done. Processed %d item(s).", len(new_items))


IMPROVE_SYSTEM_PROMPT = """You are a curator improving existing articles on AIlore, a knowledge platform about AI agents.

Your job: review ALL published chunks of a topic and propose improvements.

## What to fix (per chunk)

1. **Missing title/subtitle**: if a chunk has no title, generate a concise section title (max 10 words). If no subtitle, generate a one-line subtitle that summarizes the chunk's angle. Titles should read like section headings, not sentences.
2. **Content quality**: if the content is superficial, vague, or reads like generic filler, rewrite it to be more specific and substantive. Keep the same topic angle but add depth.
3. **Missing citations**: add [ref:description;url:https://...] for claims that need sourcing. Use real, verifiable sources only.
4. **Hallucinated citations**: remove or replace [ref:...] entries that cite non-existent papers or have wrong author/title/URL.
5. **Broken or wrong URLs**: fix URLs that are clearly wrong (typos, dead domains for well-known resources).
6. **Internal links**: add [[topic-slug]] links to connect related articles. Only link to slugs from the provided list of existing topics.
7. **Malformed syntax**: fix unclosed [ref:] or [[]] brackets.

## Duplicate detection

If two or more chunks in the topic cover essentially the same ground, flag them as duplicates. The platform will handle deduplication — your job is to identify them.

## Chunk ordering

Propose a logical reading order for all chunks. Consider: general→specific, foundational→advanced, problem→solution.

## Rules

- Do NOT invent sources. If you cannot find a real source, leave the claim unsourced.
- Do NOT add internal links to topics that don't exist — only use slugs from the provided list.
- Do NOT link a topic to itself.
- Only cite a paper if you are certain it specifically covers the topic at hand.
- If a chunk is already good (has title, good content, proper sources/links), mark it as "skip".
- Content rewrites should preserve the author's core argument and expertise level.

## Response format

Respond with a JSON object:
{
  "chunks": [
    {
      "chunk_id": "uuid",
      "action": "edit" | "skip",
      "title": "proposed title (or null if already has one)",
      "subtitle": "proposed subtitle (or null if already has one)",
      "improved_content": "full chunk content with fixes (only if action=edit)",
      "changes": ["description of each change"],
      "reason": "why skip (only if action=skip)"
    }
  ],
  "duplicates": [
    {"chunk_ids": ["uuid1", "uuid2"], "reason": "why these are duplicates"}
  ],
  "suggested_order": ["chunk_id_1", "chunk_id_2", "..."]
}

Always respond with valid JSON."""


import re


URL_CHECK_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; AIlore-Curator/1.0; +https://ailore.ai)"}
CROSSREF_HEADERS = {"User-Agent": "AIlore-Curator/1.0 (mailto:steven.johnson.ai2@gmail.com)"}

DOI_PATTERNS = [
    (r'dl\.acm\.org/doi/(10\.\d+/.+?)(?:\?|#|$)', None),
    (r'link\.springer\.com/article/(10\.\d+/.+?)(?:\?|#|$)', None),
    (r'onlinelibrary\.wiley\.com/.*/doi/(?:abs/|full/)?(10\.\d+/.+?)(?:\?|#|$)', None),
    (r'doi\.org/(10\.\d+/.+?)(?:\?|#|$)', None),
    (r'ieeexplore\.ieee\.org/document/(\d+)', 'ieee'),
    (r'nature\.com/articles/([a-z0-9\-]+)', 'nature'),
]


def check_doi_crossref(doi: str, timeout: float = 5.0) -> bool:
    try:
        r = requests.get(
            f"https://api.crossref.org/works/{doi}",
            headers=CROSSREF_HEADERS,
            timeout=timeout,
        )
        return r.status_code == 200
    except Exception:
        return False


def extract_doi(url: str) -> str | None:
    for pattern, special in DOI_PATTERNS:
        m = re.search(pattern, url)
        if m:
            if special:
                return None
            return m.group(1)
    return None


def check_url(url: str, timeout: float = 5.0) -> bool | None:
    """Returns True (verified), False (dead/fake), None (unverifiable)."""
    try:
        if "arxiv.org/abs/" in url:
            r = requests.get(url, timeout=timeout, allow_redirects=True, headers=URL_CHECK_HEADERS)
            return r.status_code < 400 and "not recognized" not in r.text[:2000]

        doi = extract_doi(url)
        if doi:
            return check_doi_crossref(doi, timeout)

        r = requests.head(url, timeout=timeout, allow_redirects=True, headers=URL_CHECK_HEADERS)
        if r.status_code == 403:
            return None
        return r.status_code < 400
    except Exception:
        return None


def validate_refs(content: str, original_content: str) -> tuple[str, list, list]:
    """Validate new [ref:...;url:...] entries. Returns (cleaned_content, stripped_urls, unverified_urls)."""
    original_urls = set(re.findall(r'\[ref:[^]]*;url:(https?://[^\];\s]+)', original_content))
    new_refs = re.findall(r'(\[ref:[^]]*;url:(https?://[^\];\s]+)[^\]]*\])', content)

    stripped = []
    unverified = []
    for full_ref, url in new_refs:
        if url in original_urls:
            continue
        result = check_url(url)
        if result is False:
            log.warning("  ⚠ Stripping dead/fake URL: %s", url)
            content = content.replace(full_ref, "")
            stripped.append(url)
        elif result is None:
            log.warning("  ⚠ Unverifiable URL (kept but flagged): %s", url)
            unverified.append(url)

    content = re.sub(r'  +', ' ', content).strip()
    return content, stripped, unverified


def load_improved() -> dict:
    if IMPROVED_FILE.exists():
        return json.loads(IMPROVED_FILE.read_text())
    return {}


def save_improved(improved: dict):
    IMPROVED_FILE.write_text(json.dumps(improved, indent=2))


def fetch_all_topics(base_url: str, api_key: str) -> list:
    all_topics = []
    page = 1
    while True:
        data = api_get(base_url, "/v1/topics", api_key, {"limit": 50, "page": page})
        topics = data.get("data", [])
        if not topics:
            break
        all_topics.extend(topics)
        pagination = data.get("pagination", {})
        if page >= pagination.get("totalPages", 1):
            break
        page += 1
    return all_topics


def fetch_topic_chunks(base_url: str, api_key: str, topic_id: str) -> list:
    data = api_get(base_url, f"/v1/topics/{topic_id}/chunks", api_key, {"status": "published", "limit": 50})
    return data.get("data", [])


def ask_improve_topic(client: OpenAI, chunks: list, topic: dict, existing_slugs: list) -> dict:
    chunks_data = []
    for c in chunks:
        chunks_data.append({
            "chunk_id": c.get("id"),
            "title": c.get("title"),
            "subtitle": c.get("subtitle"),
            "content": c.get("content", ""),
        })

    user_msg = json.dumps({
        "topic_title": topic.get("title", ""),
        "topic_slug": topic.get("slug", ""),
        "chunks": chunks_data,
        "existing_topic_slugs": existing_slugs,
    }, ensure_ascii=False)

    resp = client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": IMPROVE_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.1,
        max_tokens=4000,
        response_format={"type": "json_object"},
    )

    raw = resp.choices[0].message.content
    return json.loads(raw)


def run_improve(dry_run: bool = False, max_edits: int = 5):
    base_url, api_key, ds_key = load_config()
    ds_client = OpenAI(api_key=ds_key, base_url="https://api.deepseek.com")

    improved = load_improved()

    log.info("Fetching all topics...")
    topics = fetch_all_topics(base_url, api_key)
    log.info("Found %d topics", len(topics))

    existing_slugs = [t.get("slug", "") for t in topics if t.get("slug")]

    edits_submitted = 0

    for topic in topics:
        if edits_submitted >= max_edits:
            log.info("Reached max edits (%d), stopping.", max_edits)
            break

        topic_id = topic["id"]
        topic_title = topic.get("title", "?")
        topic_slug = topic.get("slug", "?")

        chunks = fetch_topic_chunks(base_url, api_key, topic_id)
        if not chunks:
            continue

        # Skip topics where all chunks have already been processed
        unprocessed = [c for c in chunks if c["id"] not in improved]
        if not unprocessed:
            continue

        log.info("Analyzing topic: [%s] %s (%d chunks, %d unprocessed)",
                 topic_slug, topic_title, len(chunks), len(unprocessed))

        try:
            result = ask_improve_topic(ds_client, chunks, topic, existing_slugs)

            # Process per-chunk decisions
            for chunk_decision in result.get("chunks", []):
                if edits_submitted >= max_edits:
                    break

                chunk_id = chunk_decision.get("chunk_id")
                if not chunk_id or chunk_id in improved:
                    continue

                action = chunk_decision.get("action", "skip")
                chunk_data = next((c for c in chunks if c["id"] == chunk_id), None)
                if not chunk_data:
                    continue

                if action == "skip":
                    log.info("  [%s] Skip: %s", chunk_id[:8], chunk_decision.get("reason", "no changes needed"))
                    improved[chunk_id] = {
                        "action": "skip",
                        "reason": chunk_decision.get("reason"),
                        "processed_at": datetime.now(timezone.utc).isoformat(),
                        "topic": topic_title,
                    }
                    continue

                # Build edit payload
                new_content = chunk_decision.get("improved_content", chunk_data.get("content", ""))
                new_title = chunk_decision.get("title")
                new_subtitle = chunk_decision.get("subtitle")
                changes = chunk_decision.get("changes", [])

                content_changed = new_content and new_content != chunk_data.get("content", "")
                title_changed = new_title and new_title != chunk_data.get("title")
                subtitle_changed = new_subtitle and new_subtitle != chunk_data.get("subtitle")

                if not content_changed and not title_changed and not subtitle_changed:
                    log.info("  [%s] Skip: no effective changes", chunk_id[:8])
                    improved[chunk_id] = {
                        "action": "skip",
                        "reason": "no effective changes after analysis",
                        "processed_at": datetime.now(timezone.utc).isoformat(),
                        "topic": topic_title,
                    }
                    continue

                # Validate new URLs in content
                stripped = []
                unverified = []
                if content_changed:
                    new_content, stripped, unverified = validate_refs(new_content, chunk_data.get("content", ""))
                    if stripped:
                        changes.append(f"Stripped {len(stripped)} dead URL(s): {', '.join(stripped)}")
                    if unverified:
                        changes.append(f"Unverified {len(unverified)} URL(s) (kept): {', '.join(unverified)}")

                    if new_content == chunk_data.get("content", "") and not title_changed and not subtitle_changed:
                        log.info("  [%s] Skip: content identical after URL validation", chunk_id[:8])
                        improved[chunk_id] = {
                            "action": "skip",
                            "reason": "all content changes stripped by URL validation",
                            "processed_at": datetime.now(timezone.utc).isoformat(),
                            "topic": topic_title,
                        }
                        continue

                for change in changes:
                    log.info("  [%s] Change: %s", chunk_id[:8], change)
                if title_changed:
                    log.info("  [%s] Title: %s", chunk_id[:8], new_title)
                if subtitle_changed:
                    log.info("  [%s] Subtitle: %s", chunk_id[:8], new_subtitle)

                if not dry_run:
                    try:
                        payload = {"content": new_content or chunk_data.get("content", "")}
                        if title_changed:
                            payload["title"] = new_title
                        if subtitle_changed:
                            payload["subtitle"] = new_subtitle
                        api_post(base_url, f"/v1/chunks/{chunk_id}/propose-edit", api_key, payload)
                        log.info("  [%s] Edit proposed", chunk_id[:8])
                    except requests.HTTPError as e:
                        log.error("  [%s] propose-edit failed: %s", chunk_id[:8], e)
                        improved[chunk_id] = {
                            "action": "error",
                            "error": str(e),
                            "processed_at": datetime.now(timezone.utc).isoformat(),
                            "topic": topic_title,
                        }
                        continue

                edits_submitted += 1
                improved[chunk_id] = {
                    "action": "edit",
                    "changes": changes,
                    "title": new_title,
                    "subtitle": new_subtitle,
                    "stripped_urls": stripped or None,
                    "unverified_urls": unverified or None,
                    "processed_at": datetime.now(timezone.utc).isoformat(),
                    "topic": topic_title,
                }

            # Log duplicates
            for dupe in result.get("duplicates", []):
                dupe_ids = dupe.get("chunk_ids", [])
                log.warning("  ⚠ Duplicates detected: %s — %s",
                            ", ".join(i[:8] for i in dupe_ids), dupe.get("reason", ""))

            # Log suggested order
            order = result.get("suggested_order", [])
            if order:
                log.info("  Suggested order: %s", " → ".join(i[:8] for i in order))

                # Submit metachunk if not in dry-run
                if not dry_run and len(order) > 1:
                    try:
                        api_post(base_url, f"/v1/topics/{topic_id}/metachunk", api_key, {
                            "order": order,
                        })
                        log.info("  Metachunk proposed for topic %s", topic_slug)
                    except requests.HTTPError as e:
                        log.warning("  Metachunk proposal failed: %s", e)

        except Exception as e:
            log.error("  Error analyzing topic %s: %s", topic_slug, e)
            for c in unprocessed:
                improved[c["id"]] = {
                    "action": "error",
                    "error": str(e),
                    "processed_at": datetime.now(timezone.utc).isoformat(),
                    "topic": topic_title,
                }

    if not dry_run:
        save_improved(improved)
    log.info("Improve pass done. %d edit(s) submitted.", edits_submitted)


def main():
    parser = argparse.ArgumentParser(description="AIlore Curator Agent")
    parser.add_argument("--dry-run", action="store_true", help="Show decisions without executing")
    parser.add_argument("--improve", action="store_true", help="Run content improvement pass (fix sources, add links)")
    parser.add_argument("--max-edits", type=int, default=5, help="Max edits to submit per improve run (default: 5)")
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

    if args.improve:
        log.info("=== IMPROVE MODE (max %d edits) ===", args.max_edits)
        run_improve(dry_run=args.dry_run, max_edits=args.max_edits)
    else:
        run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
