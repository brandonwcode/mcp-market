// The suite against a plain Express server (how `npm start` runs it).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MODE = '1';
process.env.ADMIN_TOKEN = 'admin-secret';
const { createApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const { runSuite } = await import('./suite.js');

const s = runSuite(async () => {
  const db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  const port = 3900 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const { app } = await createApp({ db, publicUrl: base, devLogin: true });
  const server = await new Promise((r) => { const sv = app.listen(port, () => r(sv)); });
  return { base, db, close: async () => { server.close(); await db.close(); } };
});

test('local server also serves the site and images', async () => {
  const html = await fetch(`${s.base}/`).then((r) => r.text());
  assert.match(html, /MCP Market/);
  const img = await fetch(`${s.base}/img/1.png`);
  assert.equal(img.headers.get('content-type'), 'image/png');
});
