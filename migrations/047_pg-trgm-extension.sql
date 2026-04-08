-- Migration 047: Enable pg_trgm for topic title similarity checks (duplicate prevention).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
