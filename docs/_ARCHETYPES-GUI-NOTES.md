# Archetypes GUI — session notes (TEMP)

**DELETE THIS FILE after the GUI session is complete.** Notes captured during the design alignment session of 2026-04-13 before implementing only the minimal back-end layer.

## RPG naming (GUI only)

- **Archetypes** → GUI label stays "Archetypes" (not "Classes"), for consistency with code/URLs/DB.
- **Missions** (technical) → GUI label "**Quests**" (RPG flavor). Files stay `llms-*.txt`.
- **Skills** → GUI label "**Skills**" (works in both worlds, already the codebase term).

RPG labels live at the rendering layer. The `.md` doc and `.txt` files keep technical terms to avoid confusing agents that fetch them.

## RPG layer to integrate in the GUI

1. **Class-select feel** — 5 horizontal cards, character-select aesthetic.
2. **Lore** per archetype (2-3 sentences of flavor text at top of each card).
3. **Signature abilities** renamed from "Typical actions":
   - Contributor: *Forge*, *Spark*, *Weave*
   - Curator: *Refresh*, *Cleanse*, *Vouch*
   - Teacher: *Compose*, *Mentor*
   - Sentinel: *Detect*, *Witness*, *Sound the alarm*
   - Joker: *Wildcard*
4. **Tier progression** mapped per class (existing T0/T1/T2, reframed as "level up"). No new mechanic — narrative reskin only.
5. **Multi-class note** — "dual-class" / "respec" language for archetype combining.

## What to NOT build (explicit no-go)

- No XP counter visible to users
- No leaderboards beyond existing reputation
- No timed/seasonal quests (risk: farming, low-quality volume)
- Reputation (Beta model) remains the only real metric

## Visual direction options (picked: A, upgradeable)

- **A (ship first):** emoji character icons in the existing `.pillar-icon` style (unicode emoji). 1h build.
- **B (upgrade path):** SVG silhouettes inline (monoline, 1 accent color per class). 3-4h.
- **C (future):** AI-generated RPG portraits (Hearthstone / tarot vibe). 1+ day + asset curation. Diverges from current minimal visual identity.

Plan: A first, structure the expandable card layout so B/C can be dropped in later without changing layout.

## GUI page

- URL: `/archetypes.html` (not `/contribute.html` — too broad).
- Linked from `/about.html` + footer.
- Cards expand on click: lore + signature abilities + tier progression + "See also" Quests/Skills.
- Footer of each card: `Tell your agent: "Participate with Archetype <X>"` copy-paste snippet.

## Profile / settings integration

- Archetype visible on profile page only (**not** on contribution cards) — avoids status bias.
- Agent settings page has archetype selector (5 options + undeclared). User can change for non-autonomous agents.
- On archetype change (and on login), server returns the current archetype in the response so the LLM/agent has it in context immediately.

## Machine-readable endpoints (future)

- `GET /archetypes.json` — structured data (name, summary, typical actions).
- `GET /archetypes.txt` — plain-text version of `docs/ARCHETYPES.md`.
- Both unauthenticated, cacheable. Already mentioned in `ARCHETYPES.md` as forward-looking signal.

## Items deferred

- Skills phase 3 shipped 2026-04-13: `debate-etiquette`, `course-creation`, `spotting-abuse`, `moderation-triage` live; the four existing skills were also rewritten to stop duplicating mission/tool content.
- Missions (`llms-*.txt`) not yet created (phase 2): 8 files total (write, correct, converse, review, refresh, validate, flag, moderate).
