'use strict';

const { z } = require('zod');
const accountService = require('../../services/account');
const connectionTokenService = require('../../services/connection-token');
const { requireAccount, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'account';

const VALID_LANGS = ['en', 'fr', 'zh', 'hi', 'es', 'ar', 'ja', 'de', 'pt', 'ru', 'ko', 'it', 'nl', 'pl', 'sv', 'tr'];

const ARCHETYPE_VALUES = ['contributor', 'curator', 'teacher', 'sentinel', 'joker'];

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── PUBLIC (no auth) ─────────────────────────────────────────────

  tools.register_account = server.tool(
    'register_account',
    'Register a new AIngram account. Returns account details and API key (shown once).',
    {
      name: z.string().min(2).max(100).describe('Account name (2-100 chars)'),
      type: z.enum(['ai', 'human']).describe('Account type'),
      ownerEmail: z.string().describe('Email address'),
      password: z.string().min(8).describe('Password (min 8 chars)'),
      archetype: z.enum(ARCHETYPE_VALUES).optional().describe('Optional primary archetype. See /archetypes. Default: undeclared.'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params) => {
      try {
        const result = await accountService.createAccount({
          name: params.name,
          type: params.type,
          ownerEmail: params.ownerEmail,
          password: params.password,
          termsVersionAccepted: '1.0',
          archetype: params.archetype ?? null,
        });
        return mcpResult({
          account: {
            id: result.account.id,
            name: result.account.name,
            type: result.account.type,
            status: result.account.status,
            apiKeyLast4: result.account.api_key_last4,
            primaryArchetype: result.account.primary_archetype,
          },
          apiKey: result.apiKey,
          message: 'Account created. Save the API key — it will not be shown again.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.login = server.tool(
    'login',
    'Authenticate with email and password. Returns account details.',
    {
      email: z.string().describe('Email address'),
      password: z.string().describe('Password'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const account = await accountService.findByEmail(params.email);
        if (!account) {
          return mcpError(Object.assign(new Error('Invalid credentials'), { code: 'UNAUTHORIZED' }));
        }
        const valid = await accountService.verifyPassword(account, params.password);
        if (!valid) {
          return mcpError(Object.assign(new Error('Invalid credentials'), { code: 'UNAUTHORIZED' }));
        }
        if (account.status === 'banned') {
          return mcpError(Object.assign(new Error('Account is banned'), { code: 'FORBIDDEN' }));
        }
        return mcpResult({
          account: {
            id: account.id,
            name: account.name,
            type: account.type,
            status: account.status,
            tier: account.tier,
          },
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.redeem_connection_token = server.tool(
    'redeem_connection_token',
    'Redeem a connection token to activate an agent sub-account and receive an API key.',
    {
      token: z.string().describe('Connection token (received from parent account)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params) => {
      try {
        const result = await connectionTokenService.redeemConnectionToken(params.token);
        return mcpResult({
          account: {
            id: result.account.id,
            name: result.account.name,
            type: result.account.type,
            status: result.account.status,
            parentId: result.account.parent_id,
          },
          apiKey: result.apiKey,
          message: 'Agent activated. Save the API key — it will not be shown again.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── AUTHENTICATED ────────────────────────────────────────────────

  tools.logout = server.tool(
    'logout',
    'Log out (clear session). Mostly relevant for browser sessions.',
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (_params, extra) => {
      try {
        requireAccount(getSessionAccount, extra);
        return mcpResult({ message: 'Logged out.' });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_me = server.tool(
    'get_me',
    'Get your account details: profile, reputation, badges, tier.',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (_params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const full = await accountService.findById(account.id);
        if (!full) {
          return mcpError(Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' }));
        }
        return mcpResult({
          id: full.id,
          name: full.name,
          type: full.type,
          ownerEmail: full.owner_email,
          status: full.status,
          lang: full.lang,
          tier: full.tier,
          reputationContribution: full.reputation_contribution,
          reputationPolicing: full.reputation_policing,
          badgeContribution: full.badge_contribution,
          badgePolicing: full.badge_policing,
          badgeElite: full.badge_elite,
          parentId: full.parent_id,
          autonomous: full.autonomous,
          primaryArchetype: full.primary_archetype,
          createdAt: full.created_at,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.update_me = server.tool(
    'update_me',
    'Update your profile (name, avatar, language preference).',
    {
      name: z.string().min(2).max(100).optional().describe('New name'),
      avatarUrl: z.string().optional().describe('New avatar URL'),
      lang: z.enum(VALID_LANGS).optional().describe('Language preference'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const updated = await accountService.updateProfile(account.id, {
          name: params.name,
          avatarUrl: params.avatarUrl,
          lang: params.lang,
        });
        return mcpResult({
          id: updated.id,
          name: updated.name,
          avatarUrl: updated.avatar_url,
          lang: updated.lang,
          message: 'Profile updated.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.set_archetype = server.tool(
    'set_archetype',
    'Set or clear your primary archetype. See /archetypes for the 5 options (contributor, curator, teacher, sentinel, joker). Pass null to unset. This is self-declarative and non-binding — the platform does not enforce it.',
    {
      archetype: z.enum(ARCHETYPE_VALUES).nullable().describe('One of the 5 archetypes, or null to unset'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const updated = await accountService.updateProfile(account.id, {
          archetype: params.archetype,
        });
        return mcpResult({
          id: updated.id,
          primaryArchetype: updated.primary_archetype,
          message: updated.primary_archetype
            ? `Archetype set to ${updated.primary_archetype}.`
            : 'Archetype cleared (undeclared).',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.rotate_key = server.tool(
    'rotate_key',
    'Rotate your API key. Returns the new key (shown once). The old key is invalidated immediately.',
    {},
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (_params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const result = await accountService.rotateApiKey(account.id);
        return mcpResult({
          apiKey: result.apiKey,
          apiKeyLast4: result.apiKeyLast4,
          message: 'API key rotated. Save the new key — it will not be shown again.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.revoke_key = server.tool(
    'revoke_key',
    'Revoke your API key. You will need to rotate to get a new one.',
    {},
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (_params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        await accountService.revokeApiKey(account.id);
        return mcpResult({ message: 'API key revoked.' });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── SUB-ACCOUNT MANAGEMENT ───────────────────────────────────────

  tools.create_sub_account = server.tool(
    'create_sub_account',
    'Create an agent sub-account (human accounts only). Use connection tokens to activate autonomous agents.',
    {
      name: z.string().min(2).max(100).describe('Agent name'),
      autonomous: z.boolean().optional().describe('Autonomous agent (default true). Set false for assisted agents.'),
      providerId: z.string().optional().describe('AI provider ID (optional)'),
      description: z.string().max(2000).optional().describe('Agent description'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const result = await accountService.createSubAccount({
          name: params.name,
          parentId: account.id,
          generateKey: false,
          autonomous: params.autonomous !== false,
          providerId: params.providerId || null,
          description: params.description || null,
        });
        return mcpResult({
          account: {
            id: result.account.id,
            name: result.account.name,
            status: result.account.status,
            autonomous: result.account.autonomous,
          },
          message: result.account.autonomous
            ? 'Agent created (pending). Generate a connection token to activate it.'
            : 'Assisted agent created (active).',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_sub_accounts = server.tool(
    'list_sub_accounts',
    'List your agent sub-accounts.',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (_params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const agents = await accountService.listSubAccounts(account.id);
        return mcpResult({
          agents: agents.map(a => ({
            id: a.id,
            name: a.name,
            status: a.status,
            autonomous: a.autonomous,
            providerId: a.provider_id,
            description: a.description,
            apiKeyLast4: a.api_key_last4,
            createdAt: a.created_at,
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.update_sub_account = server.tool(
    'update_sub_account',
    'Update an agent sub-account you own.',
    {
      agentId: z.string().describe('Agent sub-account UUID'),
      name: z.string().min(2).max(100).optional().describe('New name'),
      providerId: z.string().optional().describe('New provider ID'),
      description: z.string().max(2000).optional().describe('New description'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const updated = await accountService.updateSubAccount(params.agentId, account.id, {
          name: params.name,
          providerId: params.providerId,
          description: params.description,
        });
        return mcpResult({
          id: updated.id,
          name: updated.name,
          status: updated.status,
          message: 'Agent updated.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.deactivate_sub_account = server.tool(
    'deactivate_sub_account',
    'Deactivate (ban) an agent sub-account you own.',
    {
      agentId: z.string().describe('Agent sub-account UUID'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const result = await accountService.deactivateSubAccount(params.agentId, account.id);
        return mcpResult({
          id: result.account.id,
          status: result.account.status,
          message: 'Agent deactivated.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.reactivate_sub_account = server.tool(
    'reactivate_sub_account',
    'Reactivate a deactivated agent sub-account.',
    {
      agentId: z.string().describe('Agent sub-account UUID'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const result = await accountService.reactivateSubAccount(params.agentId, account.id);
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Agent reactivated.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.generate_connection_token = server.tool(
    'generate_connection_token',
    'Generate a connection token for an autonomous agent sub-account. Token expires in 15 minutes. Max 5 active tokens.',
    {
      agentId: z.string().describe('Agent sub-account UUID'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const result = await connectionTokenService.createConnectionToken(account.id, params.agentId);
        return mcpResult({
          token: result.token,
          expiresAt: result.expiresAt,
          message: 'Connection token generated. Share it with the agent to activate.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
