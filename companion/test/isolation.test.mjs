import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionServer } from '../server.mjs';

test('companion serves isolated static peripherals with browser network connections blocked', async () => {
  const server = createCompanionServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(response.headers.get('permissions-policy'), /serial=\(self\)/);
    assert.match(await response.text(), /Start conversation/);
    const script = await (await fetch(base + '/app.mjs')).text();
    assert.match(script, /navigator.serial.requestPort/);
    assert.match(script, /getUserMedia/);
    assert.doesNotMatch(script, /\bfetch\s*\(|\bWebSocket\b|OPENAI_API_KEY|vercel\.app/);
    assert.equal((await fetch(base + '/api/ws')).status, 404);
    assert.equal((await fetch(base + '/app.mjs', { method: 'POST' })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
