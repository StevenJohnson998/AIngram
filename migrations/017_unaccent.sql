-- Enable unaccent extension for accent-insensitive text search.
-- Fixes: French search for "memoire" not matching content with "mémoire".
CREATE EXTENSION IF NOT EXISTS unaccent;
