// Boots the server in a child process with ACCESS_PASSWORD set and checks the gate.
// Run with: npm test
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4401;
const PASSWORD = 'hunter2';
const base = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(HERE, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), ACCESS_PASSWORD: PASSWORD, HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
  child.stdout.on('data', (chunk) => {
    if (String(chunk).includes('password gate')) {
      clearTimeout(timer);
      resolve();
    }
  });
});

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <- ' + extra}`);
  if (!cond) failures += 1;
};

try {
  const locked = await fetch(base + '/', { redirect: 'manual' });
  await locked.text();
  check('locked without password', locked.status === 401, 'status ' + locked.status);

  const api = await fetch(base + '/api/resolve', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.facebook.com/ads/library/?id=1' }),
  });
  check('api returns 401 json', api.status === 401 && (await api.json()).error.includes('Not authorised'));

  const health = await fetch(base + '/healthz');
  check('healthz open for platform probes', health.status === 200 && (await health.text()) === 'ok');

  const wrong = await fetch(base + '/?key=nope', { redirect: 'manual' });
  await wrong.text();
  check('wrong password rejected', wrong.status === 401, 'status ' + wrong.status);

  const good = await fetch(`${base}/?key=${PASSWORD}`, { redirect: 'manual' });
  await good.text();
  const cookie = good.headers.get('set-cookie') || '';
  check('correct password redirects', good.status === 302 && good.headers.get('location') === '/', good.status + ' ' + good.headers.get('location'));
  check('cookie is HttpOnly', cookie.includes('HttpOnly'), cookie);
  check('password not echoed into cookie', !cookie.includes(PASSWORD), cookie);

  const token = cookie.split(';')[0];
  const unlocked = await fetch(base + '/', { headers: { cookie: token } });
  check('cookie unlocks the UI', unlocked.status === 200 && (await unlocked.text()).includes('Ad Video Downloader'));

  const stream = await fetch(base + '/api/stream?u=' + encodeURIComponent('https://video.xx.fbcdn.net/a.mp4'));
  await stream.text();
  check('stream proxy is gated too', stream.status === 401, 'status ' + stream.status);
} finally {
  child.kill();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nauth: all green');
process.exit(failures ? 1 : 0);
