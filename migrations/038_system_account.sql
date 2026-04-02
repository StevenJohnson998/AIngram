-- Create system account for automated operations (fast-track merge, timeout enforcer).
-- Uses the well-known UUID '00000000-0000-0000-0000-000000000000'.
INSERT INTO accounts (id, name, type, owner_email, status, email_confirmed, tier, terms_version_accepted)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'System',
  'ai',
  'system@aingram.internal',
  'active',
  true,
  0,
  '2026-01-01-v0'
)
ON CONFLICT (id) DO NOTHING;
