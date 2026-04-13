// @ts-check
/**
 * GUI Agent Archetype E2E Test
 *
 * Validates the assisted-agent archetype flow via endpoints reachable from the
 * settings.html / settings.js frontend:
 *
 *   1. Human registers + confirms email + logs in
 *   2. Creates an assisted sub-agent (no archetype at creation, default undeclared)
 *   3. GET /me/agents returns primary_archetype === null by default
 *   4. PUT /me/agents/:id archetype = sentinel persists
 *   5. PUT archetype = curator switches
 *   6. Invalid archetype rejected 400
 *   7. PUT archetype = null clears back to undeclared
 */

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const http = require('http');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const unique = () => crypto.randomBytes(4).toString('hex');

function apiCall(method, path, body, cookieStr) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' },
    };
    if (data && method !== 'GET') opts.headers['Content-Length'] = Buffer.byteLength(data);
    if (cookieStr) opts.headers.Cookie = cookieStr;
    const r = http.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = b ? JSON.parse(b) : null; } catch { /* keep null */ }
        const dataField = parsed && parsed.data !== undefined ? parsed.data : parsed;
        resolve({ status: res.statusCode, data: dataField, raw: parsed, body: b, cookies: res.headers['set-cookie'] || [] });
      });
    });
    if (data && method !== 'GET') r.write(data);
    r.end();
  });
}

function mailpitGet(path) {
  return new Promise((resolve) => {
    http.get(MAILPIT + path, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b)));
    });
  });
}

test.describe('Agent archetype flow via GUI endpoints', () => {
  test.describe.configure({ mode: 'serial', timeout: 30000 });

  const EMAIL = `arch-${unique()}@example.com`;
  const PASSWORD = 'archpass123';
  const NAME = `ArchTester ${unique()}`;
  let cookie = '';
  let agent = null;

  test('1. Register + confirm + login', async () => {
    const reg = await apiCall('POST', '/v1/accounts/register', {
      name: NAME, type: 'human', ownerEmail: EMAIL,
      password: PASSWORD, termsAccepted: true,
    });
    expect(reg.status).toBe(201);

    await new Promise((r) => setTimeout(r, 500));
    const msgs = await mailpitGet('/api/v1/messages?limit=20');
    const myMsg = msgs.messages.find((m) => m.To[0].Address === EMAIL);
    expect(myMsg).toBeTruthy();
    const fullMsg = await mailpitGet('/api/v1/message/' + myMsg.ID);
    const token = fullMsg.Text.match(/token=([a-f0-9]+)/)?.[1];
    expect(token).toBeTruthy();

    const confirm = await apiCall('POST', '/v1/accounts/confirm-email', { token });
    expect(confirm.status).toBe(200);

    const login = await apiCall('POST', '/v1/accounts/login', { email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    cookie = login.cookies.map((c) => c.split(';')[0]).join('; ');
    expect(cookie).toContain('aingram_token');
  });

  test('2. Create assisted agent', async () => {
    const res = await apiCall('POST', '/v1/accounts/me/agents', {
      name: 'ArchBot ' + unique(),
      autonomous: false,
      description: 'Test agent for archetype switching',
    }, cookie);
    expect(res.status).toBe(201);
    agent = res.data.account;
    expect(agent.autonomous).toBe(false);
  });

  test('3. GET /me/agents returns primary_archetype = null by default', async () => {
    const res = await apiCall('GET', '/v1/accounts/me/agents', null, cookie);
    expect(res.status).toBe(200);
    const found = res.data.agents.find((a) => a.id === agent.id);
    expect(found).toBeTruthy();
    expect(found.primary_archetype).toBeNull();
  });

  test('4. PUT archetype = sentinel persists', async () => {
    const res = await apiCall('PUT', '/v1/accounts/me/agents/' + agent.id, { archetype: 'sentinel' }, cookie);
    expect(res.status).toBe(200);
    expect(res.data.account.primary_archetype).toBe('sentinel');

    const list = await apiCall('GET', '/v1/accounts/me/agents', null, cookie);
    const found = list.data.agents.find((a) => a.id === agent.id);
    expect(found.primary_archetype).toBe('sentinel');
  });

  test('5. PUT archetype = curator switches', async () => {
    const res = await apiCall('PUT', '/v1/accounts/me/agents/' + agent.id, { archetype: 'curator' }, cookie);
    expect(res.status).toBe(200);
    expect(res.data.account.primary_archetype).toBe('curator');
  });

  test('6. Invalid archetype rejected 400', async () => {
    const res = await apiCall('PUT', '/v1/accounts/me/agents/' + agent.id, { archetype: 'wizard' }, cookie);
    expect(res.status).toBe(400);
    expect(res.raw.error.code).toBe('VALIDATION_ERROR');
  });

  test('7. PUT archetype = null clears back to undeclared', async () => {
    const res = await apiCall('PUT', '/v1/accounts/me/agents/' + agent.id, { archetype: null }, cookie);
    expect(res.status).toBe(200);
    expect(res.data.account.primary_archetype).toBeNull();
  });
});
