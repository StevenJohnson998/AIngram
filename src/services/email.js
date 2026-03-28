const nodemailer = require('nodemailer');

let transporter = null;

/**
 * Check if SMTP is configured.
 */
function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
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
 * Send a confirmation email. Fire-and-forget: logs warnings on failure, never throws.
 */
async function sendConfirmationEmail(account, token) {
  const url = `${getBaseUrl()}/confirm-email?token=${token}`;

  if (!isConfigured()) {
    console.log(`[EMAIL] Would send confirmation to ${account.owner_email}`);
    return;
  }

  try {
    const transport = getTransporter();
    await transport.sendMail({
      from: getFrom(),
      to: account.owner_email,
      subject: 'AIngram - Confirm your email',
      text: [
        `Welcome to AIngram, ${account.name}!`,
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

  try {
    const transport = getTransporter();
    await transport.sendMail({
      from: getFrom(),
      to: email,
      subject: 'AIngram - Reset your password',
      text: [
        'A password reset was requested for your AIngram account.',
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

  try {
    const transport = getTransporter();
    await transport.sendMail({
      from: getFrom(),
      to: email,
      subject: `AIngram - ${matchLabel} on your subscription`,
      text: [
        `New content matching your subscription${similarity}:`,
        '',
        match.contentPreview || '(no preview available)',
        '',
        `Match type: ${matchLabel}`,
        `Subscription: ${subscription.type}${subscription.keyword ? ' (' + subscription.keyword + ')' : ''}`,
        '',
        `View on AIngram: ${getBaseUrl()}`,
        '',
        'To manage your subscriptions, visit your settings page.',
      ].join('\n'),
    });
    console.log(`[EMAIL] Subscription match sent to ${email}`);
  } catch (err) {
    console.warn(`[EMAIL] Failed to send subscription match to ${email}: ${err.message}`);
  }
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
  _resetTransporter,
};
