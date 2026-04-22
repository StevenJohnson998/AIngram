const nodemailer = require('nodemailer');

let transporter = null;

/**
 * Check if SMTP is configured.
 */
function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

/**
 * Global daily email quota. Protects against burning through provider's cap
 * (e.g. Brevo free tier = 300/day). Configurable via SMTP_DAILY_LIMIT env var.
 * Returns { allowed, count, limit }. A small race window means 1-2 sends may
 * exceed the limit in rare concurrent bursts — acceptable when the soft limit
 * leaves buffer below the hard cap.
 */
async function checkAndIncrementDailyQuota() {
  const limit = parseInt(process.env.SMTP_DAILY_LIMIT || '250', 10);
  const { getPool } = require('../config/database');
  const pool = getPool();

  const { rows: readRows } = await pool.query(
    'SELECT count FROM email_daily_counter WHERE day = CURRENT_DATE'
  );
  const current = readRows[0]?.count || 0;
  if (current >= limit) {
    return { allowed: false, count: current, limit };
  }

  const { rows: incRows } = await pool.query(
    `INSERT INTO email_daily_counter (day, count) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE SET count = email_daily_counter.count + 1, updated_at = now()
     RETURNING count`
  );
  return { allowed: true, count: incRows[0].count, limit };
}

/**
 * Wraps a send. Checks quota, logs a warning + skips if over, otherwise runs the
 * sendMail call. Keeps the log format consistent so operators can grep for skipped
 * emails and see the email type + recipient + counter state.
 */
async function gatedSend(emailType, recipient, sendFn) {
  let quota;
  try {
    quota = await checkAndIncrementDailyQuota();
  } catch (err) {
    console.warn(`[EMAIL] Quota check failed, sending anyway: ${err.message}`);
    return sendFn();
  }
  if (!quota.allowed) {
    console.warn(`[EMAIL] SKIPPED ${emailType} to ${recipient}: daily quota reached (${quota.count}/${quota.limit})`);
    return;
  }
  return sendFn();
}

/**
 * Get or create the nodemailer transporter (lazy init).
 */
function getTransporter() {
  if (transporter) return transporter;
  if (!isConfigured()) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false, // STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  return transporter;
}

/**
 * Get the sender address.
 */
function getFrom() {
  return process.env.SMTP_FROM || process.env.SMTP_USER;
}

/**
 * Get the base URL for email links.
 */
function getBaseUrl() {
  return process.env.AINGRAM_GUI_ORIGIN || 'http://localhost:3000';
}

/**
 * Get the brand name for email subjects and body text. Uses BRAND_NAME env var
 * so deployments (e.g. AILore) get their own branding instead of the generic
 * "AIngram" default. Matches the pattern used in src/index.js for the GUI.
 */
function getBrand() {
  return process.env.BRAND_NAME || 'AIngram';
}

/**
 * Send a confirmation email. Fire-and-forget: logs warnings on failure, never throws.
 */
async function sendConfirmationEmail(account, token) {
  const url = `${getBaseUrl()}/confirm-email?token=${token}`;

  if (!isConfigured()) {
    console.log(`[EMAIL] Would send confirmation to ${account.owner_email}`);
    return;
  }

  return gatedSend('confirmation', account.owner_email, async () => {
    try {
      const transport = getTransporter();
      await transport.sendMail({
        from: getFrom(),
        to: account.owner_email,
        subject: `${getBrand()} - Confirm your email`,
        text: [
          `Welcome to ${getBrand()}, ${account.name}!`,
          '',
          'Please confirm your email address by visiting the link below:',
          url,
          '',
          'This link expires in 24 hours.',
          '',
          'If you did not create this account, you can ignore this email.',
        ].join('\n'),
      });
      console.log(`[EMAIL] Confirmation sent to ${account.owner_email}`);
    } catch (err) {
      console.warn(`[EMAIL] Failed to send confirmation to ${account.owner_email}: ${err.message}`);
    }
  });
}

/**
 * Send a password reset email. Fire-and-forget: logs warnings on failure, never throws.
 */
async function sendPasswordResetEmail(email, token) {
  const url = `${getBaseUrl()}/reset-password?token=${token}`;

  if (!isConfigured()) {
    console.log(`[EMAIL] Would send password reset to ${email}`);
    return;
  }

  return gatedSend('password_reset', email, async () => {
    try {
      const transport = getTransporter();
      await transport.sendMail({
        from: getFrom(),
        to: email,
        subject: `${getBrand()} - Reset your password`,
        text: [
          `A password reset was requested for your ${getBrand()} account.`,
          '',
          'Reset your password by visiting the link below:',
          url,
          '',
          'This link expires in 1 hour.',
          '',
          'If you did not request this, you can ignore this email.',
        ].join('\n'),
      });
      console.log(`[EMAIL] Password reset sent to ${email}`);
    } catch (err) {
      console.warn(`[EMAIL] Failed to send password reset to ${email}: ${err.message}`);
    }
  });
}

/**
 * Send a subscription match notification email. Fire-and-forget.
 * @param {string} email - Recipient email
 * @param {object} match - { chunkId, matchType, similarity, contentPreview }
 * @param {object} subscription - Subscription record
 */
async function sendSubscriptionMatchEmail(email, match, subscription) {
  if (!isConfigured()) {
    console.log(`[EMAIL] Would send subscription match to ${email}`);
    return;
  }

  const matchLabel = match.matchType === 'vector' ? 'Semantic match'
    : match.matchType === 'keyword' ? 'Keyword match'
    : 'Topic update';
  const similarity = match.similarity ? ` (${(match.similarity * 100).toFixed(0)}% similarity)` : '';

  return gatedSend('subscription_match', email, async () => {
    try {
      const transport = getTransporter();
      await transport.sendMail({
        from: getFrom(),
        to: email,
        subject: `${getBrand()} - ${matchLabel} on your subscription`,
        text: [
          `New content matching your subscription${similarity}:`,
          '',
          match.contentPreview || '(no preview available)',
          '',
          `Match type: ${matchLabel}`,
          `Subscription: ${subscription.type}${subscription.keyword ? ' (' + subscription.keyword + ')' : ''}`,
          '',
          `View on ${getBrand()}: ${getBaseUrl()}`,
          '',
          'To manage your subscriptions, visit your settings page.',
        ].join('\n'),
      });
      console.log(`[EMAIL] Subscription match sent to ${email}`);
    } catch (err) {
      console.warn(`[EMAIL] Failed to send subscription match to ${email}: ${err.message}`);
    }
  });
}

/**
 * Send a ban notification email to the account owner. Fire-and-forget.
 * Looks up account owner_email + name from DB.
 * @param {string} accountId
 * @param {string} reason - Human-readable ban reason
 */
async function sendBanNotification(accountId, reason) {
  const { getPool } = require('../config/database');
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT name, owner_email FROM accounts WHERE id = $1',
    [accountId]
  );
  if (rows.length === 0) return;
  const { name, owner_email: email } = rows[0];
  const contestEmail = process.env.INSTANCE_CONTEST_EMAIL || process.env.INSTANCE_ADMIN_EMAIL || '(not configured)';

  if (!isConfigured()) {
    console.log(`[EMAIL] Would send ban notification to ${email} (reason: ${reason})`);
    return;
  }

  return gatedSend('ban_notification', email, async () => {
    try {
      const transport = getTransporter();
      await transport.sendMail({
        from: getFrom(),
        to: email,
        subject: `${getBrand()} - Your account has been suspended`,
        text: [
          `Hello ${name},`,
          '',
          `Your ${getBrand()} account has been suspended following an automated security review.`,
          '',
          `Reason: ${reason}`,
          '',
          'What this means:',
          `- You can no longer log in or post content on ${getBrand()}.`,
          '- Your existing contributions remain visible while under review.',
          '',
          'If you believe this is a mistake, you can appeal by contacting:',
          contestEmail,
          '',
          'Please include your account name and a description of the activity you believe was flagged in error.',
          '',
          'For the full platform terms, see:',
          `${getBaseUrl()}/terms`,
          '',
          `-- The ${getBrand()} Team`,
        ].join('\n'),
      });
      console.log(`[EMAIL] Ban notification sent to ${email}`);
    } catch (err) {
      console.warn(`[EMAIL] Failed to send ban notification to ${email}: ${err.message}`);
    }
  });
}

/**
 * Reset the transporter (for testing).
 */
function _resetTransporter() {
  transporter = null;
}

module.exports = {
  isConfigured,
  sendConfirmationEmail,
  sendPasswordResetEmail,
  sendSubscriptionMatchEmail,
  sendBanNotification,
  _resetTransporter,
};
