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
 * Reset the transporter (for testing).
 */
function _resetTransporter() {
  transporter = null;
}

module.exports = {
  isConfigured,
  sendConfirmationEmail,
  sendPasswordResetEmail,
  _resetTransporter,
};
