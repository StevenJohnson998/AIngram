-- Migration 035: Prompt injection risk scoring
-- Sprint 9 — Prompt injection protection

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS injection_risk_score REAL DEFAULT 0.0;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS injection_flags TEXT[];
