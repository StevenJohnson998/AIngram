#!/usr/bin/env node
/**
 * Refresh analytics report — run via docker exec.
 * Usage: docker exec aingram-api-test node scripts/refresh-report.js
 *
 * Not exposed via API. Aggregates all refresh stats, reputation breakdowns,
 * and gaming alerts into a single readable report.
 */

const { getPool } = require('../src/config/database');

// Force DB pool init
getPool();

const { generateFullReport } = require('../src/services/refresh-analytics');

(async () => {
  try {
    const report = await generateFullReport();

    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║          REFRESH ANALYTICS REPORT                   ║');
    console.log('║          ' + report.generatedAt.substring(0, 19) + '                    ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    // Global stats
    console.log('\n── GLOBAL STATS ──');
    const g = report.global;
    console.log('  Refreshers:      ' + g.total_refreshers);
    console.log('  Total refreshes: ' + g.total_refreshes);
    console.log('  Verifications:   ' + g.total_verifications);
    console.log('  Updates:         ' + g.total_updates);
    console.log('  Topics touched:  ' + g.topics_refreshed);
    console.log('  Flags:  pending=' + g.flags.pending + '  addressed=' + g.flags.addressed + '  dismissed=' + g.flags.dismissed);

    // Alerts
    console.log('\n── ALERTS (' + report.alerts.agentsWithAlerts + ' agent(s)) ──');
    if (report.alerts.details.length === 0) {
      console.log('  No alerts.');
    } else {
      report.alerts.details.forEach(a => {
        console.log('  ' + a.accountName + ' (' + a.accountId.substring(0, 8) + '):');
        a.alerts.forEach(al => {
          console.log('    [' + al.severity.toUpperCase() + '] ' + al.signal + ': ' + al.detail);
        });
      });
    }

    // Per-agent details
    console.log('\n── PER-AGENT STATS ──');
    if (report.agents.length === 0) {
      console.log('  No refresh activity yet.');
    } else {
      report.agents.forEach(a => {
        console.log('\n  ' + a.accountName + ' (' + a.accountType + ', ' + a.accountId.substring(0, 8) + ')');
        console.log('    Rep: ' + a.reputationContribution.toFixed(3));
        console.log('    Refreshes: ' + a.stats.totalRefreshes + ' (' + a.stats.uniqueTopics + ' unique topics)');
        console.log('    Ops: ' + a.stats.verifyCount + ' verify, ' + a.stats.updateCount + ' update');
        console.log('    Hollow verifies: ' + a.stats.hollowVerifyCount + ' (' + (a.signals.hollowVerifyRate * 100).toFixed(0) + '%)');
        console.log('    Velocity: ' + a.signals.velocity + ' refresh/day');
        console.log('    Topic diversity: ' + (a.signals.topicDiversityRate * 100).toFixed(0) + '%');

        // Reputation breakdown
        const rb = a.reputationBreakdown;
        if (rb) {
          console.log('    Reputation breakdown:');
          const entries = Object.entries(rb).filter(([, v]) => v.pct > 0 || v.delta || v.portion);
          entries.forEach(([key, v]) => {
            const value = v.delta !== undefined ? v.delta.toFixed(3) : v.portion !== undefined ? v.portion.toFixed(3) : '?';
            console.log('      ' + key.padEnd(16) + ' ' + value.padStart(7) + '  (' + String(v.pct).padStart(3) + '%)  ' + v.detail);
          });
        }

        if (a.alerts.length > 0) {
          console.log('    ALERTS:');
          a.alerts.forEach(al => {
            console.log('      [' + al.severity.toUpperCase() + '] ' + al.detail);
          });
        }
      });
    }

    // Recent activity
    console.log('\n── RECENT ACTIVITY (last ' + report.recentActivity.length + ') ──');
    report.recentActivity.forEach(a => {
      const ts = a.created_at.toISOString().substring(0, 19);
      const meta = a.metadata ? JSON.stringify(a.metadata).substring(0, 60) : '';
      console.log('  ' + ts + '  ' + a.account_name.padEnd(15) + '  ' + a.action.padEnd(25) + '  ' + (a.topic_title || a.target_id.substring(0, 8)) + '  ' + meta);
    });

    console.log('\n── END OF REPORT ──');

    const pool = getPool();
    await pool.end();
  } catch (err) {
    console.error('Report failed:', err);
    process.exit(1);
  }
})();
