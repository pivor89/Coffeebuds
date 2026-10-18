const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

test('login is rate limited after 10 attempts', async () => {
  const PORT = 3900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbrl-')), 't.sqlite'), DISABLE_RATE_LIMIT: '' };
  delete env.DATABASE_URL;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => { srv.stdout.on('data', (d) => /running on/.test(d) && res()); srv.on('exit', rej); setTimeout(() => rej(new Error('server start timeout')), 20000); });
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CoffeeBuds' }, body: '{"email":"x@y.zz","password":"nope"}' });
      codes.push(r.status);
    }
    assert.deepStrictEqual(codes.slice(0, 10), Array(10).fill(401));
    assert.strictEqual(codes[11], 429);
  } finally { srv.kill(); }
});
