'use strict';

const { z } = require('zod');
const reportService = require('../../services/report');
const sanctionService = require('../../services/sanction');
const { requireAccount, requireBadge, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'reports_sanctions';

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── REPORTS ───��──────────────────────────────────────────────────

  tools.create_report = server.tool(
    'create_report',
    'Report content for legal/compliance review (LCEN/DSA). Public endpoint, no auth required.',
    {
      contentId: z.string().describe('Content UUID (topic or chunk)'),
      contentType: z.enum(['topic', 'chunk']).describe('Content type'),
      reason: z.string().min(10).describe('Reason for report (min 10 chars)'),
      reporterEmail: z.string().describe('Reporter email address'),
    },
    async (params) => {
      try {
        const report = await reportService.createReport({
          contentId: params.contentId,
          contentType: params.contentType,
          reason: params.reason,
          reporterEmail: params.reporterEmail,
        });
        return mcpResult({
          id: report.id,
          contentId: report.content_id,
          contentType: report.content_type,
          status: report.status,
          createdAt: report.created_at,
          message: 'Report submitted.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_reports = server.tool(
    'list_reports',
    'List content reports. Requires policing badge.',
    {
      status: z.enum(['pending', 'reviewing', 'resolved', 'dismissed', 'taken_down', 'counter_noticed', 'restored']).optional().describe('Filter by status (default: pending)'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await reportService.listReports({
          status: params.status || 'pending',
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          reports: result.data.map(r => ({
            id: r.id,
            contentId: r.content_id,
            contentType: r.content_type,
            reason: r.reason,
            reporterEmail: r.reporter_email,
            status: r.status,
            createdAt: r.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.resolve_report = server.tool(
    'resolve_report',
    'Resolve or dismiss a report. Requires policing badge.',
    {
      reportId: z.string().describe('Report UUID'),
      status: z.enum(['resolved', 'dismissed']).describe('Resolution status'),
      adminNotes: z.string().optional().describe('Admin notes'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await reportService.resolveReport(params.reportId, {
          status: params.status,
          adminNotes: params.adminNotes || null,
          resolvedBy: account.id,
        });
        return mcpResult({
          id: result.id,
          status: result.status,
          message: `Report ${params.status}.`,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.takedown_report = server.tool(
    'takedown_report',
    'Execute a DMCA takedown on reported content. Requires policing badge + copyright reputation.',
    {
      reportId: z.string().describe('Report UUID'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await reportService.takedownReport(params.reportId, {
          takenDownBy: account.id,
          reviewerCopyrightRep: account.reputationCopyright || 0,
        });
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Content taken down.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.counter_notice = server.tool(
    'counter_notice',
    'File a counter-notice against a takedown. Public, no auth required.',
    {
      reportId: z.string().describe('Report UUID'),
      email: z.string().describe('Contact email'),
      reason: z.string().min(50).describe('Counter-notice reason (min 50 chars)'),
    },
    async (params) => {
      try {
        const result = await reportService.counterNotice(params.reportId, {
          email: params.email,
          reason: params.reason,
        });
        return mcpResult({
          id: result.id,
          status: result.status,
          restorationEligibleAt: result.restoration_eligible_at,
          message: 'Counter-notice filed.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── SANCTIONS ────────────────────────────────────────────────────

  tools.create_sanction = server.tool(
    'create_sanction',
    'Create a sanction against an account. Severity determines type (minor escalates, grave = ban). Requires policing badge.',
    {
      accountId: z.string().describe('Target account UUID'),
      severity: z.enum(['minor', 'grave']).describe('Sanction severity'),
      reason: z.string().describe('Reason for sanction'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const sanction = await sanctionService.createSanction({
          accountId: params.accountId,
          severity: params.severity,
          reason: params.reason,
          issuedBy: account.id,
        });
        return mcpResult({
          id: sanction.id,
          accountId: sanction.account_id,
          severity: sanction.severity,
          type: sanction.type,
          active: sanction.active,
          message: `Sanction created (${sanction.type}).`,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.lift_sanction = server.tool(
    'lift_sanction',
    'Lift an active sanction. Sets 30-day probation period. Requires policing badge.',
    {
      sanctionId: z.string().describe('Sanction UUID'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await sanctionService.liftSanction(params.sanctionId);
        return mcpResult({
          id: result.id,
          active: result.active,
          liftedAt: result.lifted_at,
          message: 'Sanction lifted. 30-day probation period started.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_active_sanctions = server.tool(
    'list_active_sanctions',
    'List all currently active sanctions. Requires policing badge.',
    {
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await sanctionService.listAllActive({
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          sanctions: result.data.map(s => ({
            id: s.id,
            accountId: s.account_id,
            severity: s.severity,
            type: s.type,
            reason: s.reason,
            issuedBy: s.issued_by,
            issuedAt: s.issued_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_sanction_history = server.tool(
    'get_sanction_history',
    'Get sanction history for an account (public).',
    {
      accountId: z.string().describe('Account UUID'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    async (params) => {
      try {
        const result = await sanctionService.getSanctionHistory(params.accountId, {
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          sanctions: result.data.map(s => ({
            id: s.id,
            severity: s.severity,
            type: s.type,
            reason: s.reason,
            active: s.active,
            issuedAt: s.issued_at,
            liftedAt: s.lifted_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
