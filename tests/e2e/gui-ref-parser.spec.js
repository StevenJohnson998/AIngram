// @ts-check
// Regression: [ref:desc;url:...] in discussion messages must render as an
// inline source link, and [ref:desc] as an emphasized descriptor — never as
// raw bracket syntax (agents post refs in this format; REX 2026-06-05 P7).
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const crypto = require('crypto');

const BASE = process.env.BASE_URL || 'http://172.18.0.13:3000';
const API_CONTAINER = process.env.API_CONTAINER || 'aingram-api-test';
const unique = () => crypto.randomBytes(4).toString('hex');

function createUserInDB({ tier = 2, type = 'ai' } = {}) {
  const id = unique();
  const email = `e2e-refparser-${id}@example.com`;
  const name = `RefParser-Agent-${id}`;
  const script = `
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const accountId = crypto.randomUUID();
      const pwHash = bcrypt.hashSync('TestPass2026!', 10);
      const prefix = crypto.randomBytes(4).toString('hex');
      const secret = crypto.randomBytes(12).toString('hex');
      const keyHash = bcrypt.hashSync(secret, 10);
      await pool.query(
        \`INSERT INTO accounts (id, name, type, owner_email, password_hash, status, email_confirmed, tier,
         badge_policing, badge_contribution, reputation_contribution, reputation_copyright,
         first_contribution_at, terms_version_accepted, api_key_hash, api_key_prefix)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,false,false,0.5,0.5,now(),$8,$9,$10)\`,
        [accountId, '${name}', '${type}', '${email}', pwHash, 'active',
         parseInt('${tier}'), '2026-03-21-v1', keyHash, prefix]
      );
      console.log(JSON.stringify({ id: accountId, email: '${email}', name: '${name}', apiKey: \`aingram_\${prefix}_\${secret}\` }));
      await pool.end();
    })();
  `;
  const raw = execSync(`docker exec -i ${API_CONTAINER} node`, { input: script, encoding: 'utf-8', timeout: 10000 }).trim();
  return JSON.parse(raw);
}

test.describe('[ref:] rendering in debate messages', () => {
  let topicId;

  test.beforeAll(async ({ request }) => {
    const user = createUserInDB({ tier: 2, type: 'ai' });
    const headers = { Authorization: `Bearer ${user.apiKey}` };
    const now = Date.now();

    const topicRes = await request.post(BASE + '/v1/topics/full', {
      headers,
      data: {
        title: `Ref Parser E2E ${unique()}`,
        lang: 'en',
        summary: 'E2E fixture: [ref:] rendering in discussion messages.',
        category: 'field-notes',
        topicType: 'debate',
        startsAt: new Date(now - 3600_000).toISOString(),
        endsAt: new Date(now + 3600_000).toISOString(),
        chunks: [{ title: 'Context', content: 'Fixture debate for GUI ref parser regression test.' }],
      },
    });
    expect(topicRes.status(), await topicRes.text()).toBe(201);
    const topicJson = await topicRes.json();
    topicId = topicJson.data?.id || topicJson.data?.topic?.id || topicJson.id;
    expect(topicId).toBeTruthy();

    for (const content of [
      'Grounding check: see [ref:PPC Land on Google I/O 2026;url:https://ppc.land/inside-google-i-o-2026-the-agentic-ai-shift/] and the bare descriptor form [ref:multi-agent failure taxonomy] mid-sentence.',
      'Markdown still works: [normal link](https://example.com/page) and **bold** text.',
    ]) {
      const msgRes = await request.post(`${BASE}/v1/topics/${topicId}/messages`, {
        headers,
        data: { type: 'contribution', content },
      });
      expect(msgRes.status(), await msgRes.text()).toBe(201);
    }
  });

  test('ref with URL renders as inline link, bare ref as descriptor', async ({ page }) => {
    await page.goto(`${BASE}/topic.html?id=${topicId}`);
    const container = page.locator('#discussion-container');

    const refLink = container.locator('a.ref-link[href*="ppc.land"]');
    await expect(refLink).toBeVisible();
    await expect(refLink).toHaveText('PPC Land on Google I/O 2026');
    await expect(refLink).toHaveAttribute('target', '_blank');
    await expect(refLink).toHaveAttribute('rel', 'noopener');

    await expect(container.locator('em.ref-desc')).toHaveText('multi-agent failure taxonomy');

    // No raw [ref: syntax anywhere in the rendered discussion
    const text = await container.innerText();
    expect(text).not.toContain('[ref:');

    // Plain markdown links/formatting unaffected
    await expect(container.locator('a[href="https://example.com/page"]')).toBeVisible();
    await expect(container.locator('strong', { hasText: 'bold' })).toBeVisible();
  });
});
