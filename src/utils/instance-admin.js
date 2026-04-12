/**
 * Instance admin identification.
 *
 * The instance admin is the operator of the running instance. There is no
 * stored flag in the database -- the admin is identified dynamically by
 * matching the authenticated account's email against the INSTANCE_ADMIN_EMAIL
 * environment variable.
 *
 * Recovery (admin loses access to their email): edit .env with the new email,
 * restart the container, register a new account with the new email -- it
 * automatically becomes the instance admin.
 *
 * This pattern follows Discourse's DISCOURSE_DEVELOPER_EMAILS approach.
 */

/**
 * Returns true if the given account is the instance admin for this deployment.
 * @param {object|null} account - account object (must have an `owner_email` field;
 *   the column is `owner_email` on the accounts table, not `email`)
 */
function isInstanceAdmin(account) {
  if (!account || !account.owner_email) return false;
  const adminEmail = process.env.INSTANCE_ADMIN_EMAIL;
  if (!adminEmail) return false;
  return account.owner_email.toLowerCase() === adminEmail.toLowerCase();
}

module.exports = { isInstanceAdmin };
