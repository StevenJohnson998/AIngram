const fs = require('fs');

function validateEnv() {
  const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  const hasPassword = process.env.DB_PASSWORD || process.env.DB_PASSWORD_FILE;
  if (!hasPassword) {
    throw new Error(
      'Missing DB password: set either DB_PASSWORD or DB_PASSWORD_FILE'
    );
  }

  if (process.env.DB_PASSWORD_FILE) {
    const filePath = process.env.DB_PASSWORD_FILE;
    if (!fs.existsSync(filePath)) {
      throw new Error(`DB_PASSWORD_FILE not found: ${filePath}`);
    }
    process.env.DB_PASSWORD = fs.readFileSync(filePath, 'utf8').trim();
  }

  // JWT_SECRET is required for auth
  if (!process.env.JWT_SECRET) {
    throw new Error('Missing required environment variable: JWT_SECRET');
  }

  // INSTANCE_ADMIN_EMAIL is recommended but not required (warn-only).
  // When set, the matching account becomes the instance admin and sees
  // the QuarantineValidator health banner in the GUI.
  if (!process.env.INSTANCE_ADMIN_EMAIL) {
    console.warn('');
    console.warn('=================================================================');
    console.warn('  WARNING: INSTANCE_ADMIN_EMAIL not set');
    console.warn('  No account will be recognized as instance admin.');
    console.warn('  The QuarantineValidator health banner will not appear for anyone.');
    console.warn('  Set INSTANCE_ADMIN_EMAIL in .env to enable instance ops visibility.');
    console.warn('=================================================================');
    console.warn('');
  }

  const port = parseInt(process.env.PORT || '3000', 10);
  const dbPort = parseInt(process.env.DB_PORT, 10);

  // Construct DATABASE_URL for node-pg-migrate
  const databaseUrl = `postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${dbPort}/${process.env.DB_NAME}`;
  process.env.DATABASE_URL = databaseUrl;

  return {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: dbPort,
    DB_NAME: process.env.DB_NAME,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: process.env.JWT_SECRET,
    PORT: port,
    AINGRAM_GUI_ORIGIN: process.env.AINGRAM_GUI_ORIGIN || null,
    OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434',
    SMTP_HOST: process.env.SMTP_HOST || null,
    SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
    SMTP_USER: process.env.SMTP_USER || null,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD || null,
    SMTP_FROM: process.env.SMTP_FROM || process.env.SMTP_USER || null,
    INSTANCE_ADMIN_EMAIL: process.env.INSTANCE_ADMIN_EMAIL || null,
    INSTANCE_CONTEST_EMAIL: process.env.INSTANCE_CONTEST_EMAIL || process.env.INSTANCE_ADMIN_EMAIL || null,
    INSTANCE_CONTACT_EMAIL: process.env.INSTANCE_CONTACT_EMAIL || process.env.INSTANCE_CONTEST_EMAIL || process.env.INSTANCE_ADMIN_EMAIL || null,
  };
}

module.exports = { validateEnv };
