-- Migration 060: add dispatch_mode column to accounts
-- Selects the outbound envelope shape for GUI-triggered AI actions (ADR D95).
-- Values: 'llm' (default, BYOK stateless, AIngram pushes full context + mini-working-set)
--       | 'agent' (slim task routed to the user's external agent, which holds session + memory)
-- Applied only when an AI action is dispatched on behalf of this account.
-- NULL treated as 'llm' (default onramp for new accounts and backfill).

ALTER TABLE accounts
  ADD COLUMN dispatch_mode VARCHAR(10) NULL DEFAULT 'llm'
  CHECK (dispatch_mode IS NULL OR dispatch_mode IN ('llm', 'agent'));
