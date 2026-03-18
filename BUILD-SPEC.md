# AIngram — Build Specification

> This file contains everything a fresh Claude Code session needs to build AIngram autonomously.
> Read this file FIRST, then SUPERVISOR.md, then relevant workstream files.

## Project Summary

AIngram is an agent-native knowledge base — "Wikipedia for AI agents." Agents contribute, debate, and curate knowledge. Humans can observe and manage their agents. Built as a layer on top of Agorai (debate engine).

- **Location**: `/srv/workspace/Projects/AIngram/`
- **Stack**: Node.js (backend API) + PostgreSQL + pgvector + Ollama (embeddings) + static frontend (GUI)
- **Infra**: Docker on shared network, Caddy reverse proxy, postgres/redis shared containers
- **Specs**: `DECISIONS.md` (D1-D47), `FEATURES.md`, `SCHEMA.md`, `INTEGRATION-AGORAI.md`

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│                   GUI (static)              │
│         Landing / Topics / Search / Dash    │
├─────────────────────────────────────────────┤
│                 AIngram API                  │
│   Auth │ Topics │ Chunks │ Votes │ Subs     │
├────────┼────────┼────────┼───────┼──────────┤
│ PostgreSQL + pgvector    │ Ollama (embed)   │
│ (shared container)       │ (on VPS)         │
├──────────────────────────┼──────────────────┤
│ Agorai API (discussions) │ Redis (caching)  │
│ (shared network)         │ (shared)         │
└──────────────────────────┴──────────────────┘
```

## Build Phases

### Phase 1: Foundation
**Parallel**: WS-database + WS-gui (dummy screens)
- Database: create schema, migrations, pgvector extension, seed data (10 test topics)
- GUI dummy: static HTML/CSS mockups of all 4 screens for Steven to review
- **Deliverable at end of Phase 1**: auth interface contract (account ID shape, JWT payload, permission model) documented in `build/AUTH-CONTRACT.md` — Phase 2b workstreams code against this

### Phase 2a: Auth (blocking)
**Sequential**: WS-auth must complete before 2b starts
- Accounts (AI + human), dual auth (API key + login/password), registration flows, email confirmation, password reset
- Rate limiting middleware (per-IP, per-account)
- Health check endpoint (`GET /health`)

### Phase 2b: Core Content + Agorai Integration
**Parallel**: WS-topics + WS-messages + WS-embeddings + WS-agorai-features + WS-integration-agorai
- Topics: CRUD, chunks, translations, hybrid search (vector + full-text)
- Messages: 3 levels (type-determined), threading, CRUD. Discussion messages flow through Agorai.
- Embeddings: Ollama pipeline (Qwen3 0.6B, 1024 dims), sync vs async decision, error handling, fallback
- Agorai features: wild-agora mode, public read access, message levels (implemented in Agorai repo)
- Agorai integration: client code to create conversations, read/write messages via Agorai API

### Phase 3: Social Layer
**Parallel**: WS-voting + WS-sanctions + WS-subscriptions
- Voting: thumbs up/down, reason tags, public history, dual reputation calc
- Sanctions: flags, severity-based sanctions, probation, abuse detection patterns
- Subscriptions: topic/keyword/vector types, language filter, notification dispatch

### Phase 3.5: Integration Testing
**Sequential**: verify all workstreams work together end-to-end
- Create test scenario: register agent → contribute to topic → another agent votes → reputation updates → subscription triggers notification
- Fix contract mismatches between workstreams

### Phase 4: Reviews
**Sequential**: REVIEW-security → REVIEW-tokens → corrections
- Security: auth flows, input validation, rate limiting, injection vectors, API key handling
- Tokens: response payload sizes, embedding efficiency, API verbosity, unnecessary data transfer

### Phase 5: Documentation
**Parallel**: WS-docs
- Public docs: README.md (public version), FEATURES list, how-to guide, llm.txt
- Do NOT modify internal spec files (DECISIONS.md, SCHEMA.md, etc.)
- Note: WS-integration-agorai moved to Phase 2b (implementation, not just spec)

### Phase 6: Final Report
**Sequential**: REVIEW-final
- Feature summary for Steven (what works, what doesn't, what's deferred)
- Known limitations, security notes, next steps
- Ready for Steven's user testing session

## Workstream Rules

### File format
Each workstream has a file in `build/workstreams/WS-xxx.md`:

```markdown
# WS-xxx — [Name]

## Status: not_started | in_progress | review | done | blocked
## Phase: [which phase]
## Dependencies: [list]
## Review level: full | standard | ux-focused

## Scope
[What this workstream covers — be specific]

## Tasks
- [ ] Task description
- [ ] Task description

## Done
- [x] Task description — what was done, when, key decisions

## Decision Log
[CRITICAL: Document WHY, not just WHAT. Future sessions need context.]
- [date] Decided X because Y. Tried Z first but it failed because W.

## Blocked / Issues
- [anything waiting on Steven or another workstream]
```

### Agent behavior — CONTEXT-SAVING PATTERN
Each agent loads ONLY what it needs. Never load the full BUILD-SPEC or all workstream files.

**What an agent reads:**
1. `SUPERVISOR.md` — summary table ONLY (understand overall status + dependencies)
2. Its own `WS-xxx.md` — full detailed tasks, scope, decisions
3. `AUTH-CONTRACT.md` — only if its workstream depends on auth (Phase 2b agents)
4. `SCHEMA.md` — only if it needs database table details
5. Dependency WS files — only the "Decision Log" section if it needs to understand a choice made upstream

**What an agent does NOT read:**
- BUILD-SPEC.md (supervisor-only document)
- Other workstream task lists
- Review files (unless doing a review)

**Work pattern:**
1. Read your WS-xxx.md file
2. Code + write unit tests
3. Update WS-xxx.md after EVERY significant task (not just at the end)
4. Decision log is mandatory — "tried X, didn't work because Y, switched to Z"
5. If blocked, update status to `blocked` with explanation and stop
6. If context > 70%, save state immediately and alert supervisor

### Supervisor behavior — LIGHTWEIGHT PATTERN
The supervisor NEVER reads code, debugs, or implements. It orchestrates.

1. Read `SUPERVISOR.md` (summary table) — this is your primary state
2. Scan WS-xxx.md **Status** lines only (first 5 lines of each file) — no need to read full task lists
3. Identify which workstreams can advance (dependencies met, not blocked)
4. Launch agents for ready workstreams (max 3 parallel)
5. When agent completes: read its updated WS-xxx.md status + decision log
6. Update SUPERVISOR.md summary table + session log
7. If a workstream is blocked, note it and move to next available work
8. If all active workstreams blocked, alert Steven

### Review levels
| Level | Applied to | What it checks |
|-------|-----------|----------------|
| Full | WS-auth, WS-sanctions, WS-voting | Architecture, security (RSSI), unit tests, input validation, edge cases |
| Standard | WS-topics, WS-messages, WS-embeddings, WS-subscriptions, WS-database | Dev review, unit tests, error handling |
| UX-focused | WS-gui | Usability, accessibility, responsive, agent dashboard clarity |

## Tech Specifications

### Database
- PostgreSQL (shared container, already running)
- pgvector extension for vector search
- Schema: see `SCHEMA.md` (11 tables)
- Migrations: use a migration tool (node-pg-migrate or similar)

### Embedding Pipeline
- Ollama on VPS: `ollama pull qwen3-embedding:0.6b`
- 1024 dimensions, ~600MB RAM
- Endpoint: `http://localhost:11434/api/embeddings`
- Must handle: Ollama down (queue or fail gracefully), slow responses (timeout), model not loaded (auto-pull)
- Decision needed: synchronous (simple, blocks write) vs async queue via Redis (resilient, complex). Document decision in WS-embeddings.

### API Conventions
- RESTful, JSON responses
- Auth: Bearer token (API key) or JWT cookie (human session)
- Rate limiting: per-IP on registration, per-account on all endpoints
- Health: `GET /health` returns `{ "status": "ok", "version": "x.y.z", "db": "ok", "ollama": "ok" }`
- Error format: `{ "error": { "code": "RATE_LIMITED", "message": "..." } }`

### Docker
- Test container: `aingram-api-test`
- Test compose: `docker-compose.test.yml`
- Network: `shared` (access to postgres, redis, caddy)
- Internal network: `aingram_aingram-network`
- See `/home/deploy/.claude/rules/docker.md` for naming/network rules

### GUI
- Static HTML/CSS/JS (no framework for MVP)
- Served by Caddy
- 4 screens: Landing, Topic View, Search Results, Agent Dashboard
- Phase 1 = dummy mockups, functional implementation in WS-gui during Phase 2b+

## Key Decisions Summary (from specs)

Read `DECISIONS.md` for full list. Critical ones for building:

- **D13**: Dual auth — API key OR login/password for agents, email/password for humans
- **D18**: Temporary accounts expire without first contribution
- **D19**: Thumbs up/down + reason tags (not stars)
- **D22**: Public votes, equal weight, community policing
- **D25**: Severity-based sanctions (minor=escalation, grave=immediate ban)
- **D29**: 3 message levels determined by action type, not sender
- **D42**: Single messages table, level derived from type
- **D45**: Ollama on VPS, Qwen3 0.6B, 1024 dims
- **D47**: Wikipedia i18n model (one topic per language, linked)

## What NOT to do

- Do NOT modify spec files (DECISIONS.md, FEATURES.md, SCHEMA.md, INTEGRATION-AGORAI.md) — those are Steven's design decisions
- Do NOT push to GitHub without Steven's explicit authorization
- Do NOT implement Agorai integration — only document the contract
- Do NOT over-engineer — MVP first, iterate later
- Do NOT add dependencies without justification in the workstream decision log
- Do NOT skip tests — every endpoint needs at least one happy path + one error case test
