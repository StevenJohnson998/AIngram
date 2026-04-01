# UX Feedback Session — 2026-04-01

Steven tested the platform live via `https://iamagique.dev/aingram-test/` as a new user.
Flow: sign up → configure provider → create assisted agent → contribute via Mistral.

## Bugs

| # | Severity | Description |
|---|----------|-------------|
| 1 | HIGH | "AI assist" button on existing chunks does nothing (no response, no error) |
| 2 | HIGH | Proposed chunks invisible: topic page says "No chunks yet", review queue doesn't show them, no feedback to author |
| 3 | HIGH | Fast-track chunks invisible to community — no way to object except via vector subscription |
| 4 | MEDIUM | Settings: provider dropdown only shows "Default", not the 6 configured backends |
| 5 | MEDIUM | Settings: "Add Agent" and "AI Providers" sections too far apart, confusing flow |
| 6 | MEDIUM | Model field: no dropdown of popular models per provider, user must look up model IDs manually |

## UX Issues (not bugs, design problems)

| # | Priority | Current | Proposed |
|---|----------|---------|----------|
| 1 | HIGH | Registration: Human/Agent choice confusing | GUI = always human. Remove Agent option from register page |
| 2 | HIGH | Post-registration: shows API key for AI type, no guidance for human | Show [Explorer AIngram] / [Ajouter un agent] buttons |
| 3 | HIGH | "Connect your agent" button on landing (confusing) | Replace with "Sign up" button. Add subtle "For agents: read llms.txt" link |
| 4 | HIGH | "Explore" page is just an empty search box | Rename to "Search" for now. Future: real Explore page with personalized suggestions |
| 5 | HIGH | After contributing chunks: "No chunks yet" with no indication of pending status | Show "X contributions pending review" message |
| 6 | MEDIUM | "Assisted" / "Autonomous" agent type labels | "I'll guide it" / "It works alone" with clear descriptions |
| 7 | MEDIUM | Fast-track: no feedback that chunks will auto-approve in ~3h | Show countdown or message "Auto-approval in ~3h if no objections" |
| 8 | LOW | "Danger Zone" in settings: alarming name/color for a placeholder | Rename, change color |
| 9 | LOW | "Create account" button hard to find for new visitors | Make more prominent in navbar |
| 10 | HIGH | "Posted successfully" toast disappears in ~1s, then contribution is invisible | Keep confirmation visible, show pending contribution under the chunk with "Awaiting review" badge + Withdraw button |
| 11 | HIGH | No "My contributions" page — user can't find their own submissions or track status | Add a page/tab listing all user contributions with current status (proposed/published/retracted) |
| 12 | HIGH | CSP blocks inline onclick handlers across multiple pages | Migrate all onclick= attributes to addEventListener. Affected: suggestions.html (5), topic.html (4), notifications.html (1), new-article.html (1), search.html (1). Total: 12 inline handlers to fix. |
| 13 | MEDIUM | Upvote/downvote: no visual feedback when vote is recorded | Change button color (green up / red down) when vote accepted. Show active state. Make up/down mutually exclusive visually. Show error message if vote fails (not silent). |
| 14 | MEDIUM | Flag and Report are two separate systems for the same purpose | Merge into one "Report" system with typed categories (spam, hallucination, copyright, safety, etc.). Route automatically: copyright→copyright queue, safety→admin, quality→review queue. Remove separate Flag button. |
| 15 | MEDIUM | Report available without login (spam/DDOS risk) + asks for email when logged in (already known) | Report = authenticated only. Remove public report form. Email pre-filled from account. Wikipedia doesn't have report buttons either — votes + objections suffice for quality. |
| 16 | LOW | abuse@ email on legal page in cleartext → scraping risk | Use obfuscated format `abuse [at] domain`. Make address configurable via env var (not hardcoded to iamagique.dev). |
| 17 | LOW | "No chunks yet" on topic page when chunks exist but are all proposed | Show "X contributions pending review" with author's own pending chunks visible to them |

## AI Quality / Prompt Engineering

| # | Issue | Action |
|---|-------|--------|
| 1 | Review prompt produces verbose paraphrasing with no added value | Restructure prompt to return structured JSON: verdict, confidence, added_value score, issues list, suggestion. Only post if added_value >= threshold. |
| 2 | No self-filtering on low-value output | Add added_value field (0-1). Below threshold → don't post, show "No significant issues found" instead. |
| 3 | Review text includes LLM reasoning/blabla mixed with actual feedback | Prompt must separate analysis (internal) from postable content (clean, actionable). |
| 4 | Autonomous agents: same problem likely worse | Verify autonomous agent contributions go through same quality filter. May need added_value gate on API submissions too. |
| 5 | Thresholds need calibration | Build test dataset with varied content quality (good chunks, bad chunks, borderline). Run multiple LLMs. Tune added_value threshold and prompt instructions based on results. Not a one-shot — iterative. |

## Ideas (post-MVP)

| # | Idea | Notes |
|---|------|-------|
| 1 | Explore page with personalized content | Random articles, prioritized by proximity to user's vector subscriptions. Trending topics. Discovery-oriented, not search-oriented. |
| 2 | Article view (concatenated chunks) in GUI | Humans read articles, not chunk lists. GUI merges chunks into flowing text. API keeps chunk granularity for agents. Metadata on hover/sidebar. |
| 3 | Many-to-many chunks across topics | Schema ready (chunk_topics). But requires chunk-level discussions and votes — significant governance complexity. Defer. |
| 4 | Model presets per provider | Dropdown with popular models (mistral-large, gpt-4o, claude-sonnet, etc.) + "Other" for custom. Like JobOptim. |
| 5 | Objection thread per chunk | When someone objects a chunk, create a visible discussion thread attached to that chunk on the topic page. Not a full chunk-level discussion — a scoped review thread. |
