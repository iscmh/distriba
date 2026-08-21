#!/usr/bin/env node
/**
 * Tiny zero-dependency server for the Facebook ad video downloader.
 *
 *   GET  /                     the UI
 *   POST /api/resolve          { url } -> ad metadata + direct mp4 links
 *   GET  /api/stream?u=&name=  proxies the fbcdn bytes (download or preview)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { resolveAd, isAllowedMediaUrl, suggestFilename, UA } from './src/extract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Optional shared password. Unset (the normal local case) means no gate; set it
 * whenever the server is reachable from the internet, so the download proxy is
 * not left open to whoever finds the URL.
 */
const PASSWORD = process.env.ACCESS_PASSWORD || '';
const COOKIE = 'fbdl_auth';
const TOKEN = PASSWORD
  ? crypto.createHash('sha256').update(`fbdl:${PASSWORD}`).digest('hex')
  : '';

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function isAuthed(req, url) {
  if (!PASSWORD) return true;
  const supplied = url.searchParams.get('key');
  if (supplied && sameSecret(supplied, PASSWORD)) return true;
  const cookie = cookieValue(req.headers.cookie, COOKIE);
  return Boolean(cookie) && sameSecret(cookie, TOKEN);
}

const LOGIN_PAGE = `<!DOCTYPE html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8ecf5;
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
form{background:#141821;border:1px solid #262d3d;border-radius:14px;padding:24px;width:min(340px,90vw)}
h1{font-size:18px;margin:0 0 14px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #262d3d;
background:#0b0d12;color:#e8ecf5;font-size:16px;margin-bottom:10px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#4a8cff;color:#fff;font-size:15px;
font-weight:600}p{color:#8b95ab;font-size:13px;margin:12px 0 0}</style>
<form method="GET" action="/"><h1>Ad downloader</h1>
<input type="password" name="key" placeholder="Password" autofocus>
<button type="submit">Unlock</button><p>Set by ACCESS_PASSWORD on the server.</p></form>`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  // Keep path traversal out of the static handler.
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

async function handleResolve(req, res) {
  let input;
  try {
    input = JSON.parse(await readBody(req)).url;
  } catch {
    sendJson(res, 400, { error: 'Expected a JSON body like {"url": "..."}' });
    return;
  }

  try {
    const ad = await resolveAd(input, { browser: process.env.FB_BROWSER_FALLBACK || 'auto' });
    const videos = ad.videos.map((v, i) => ({
      ...v,
      downloads: [
        v.hd && { quality: 'hd', url: v.hd, filename: suggestFilename(ad.adId, i, 'hd') },
        v.sd && { quality: 'sd', url: v.sd, filename: suggestFilename(ad.adId, i, 'sd') },
      ].filter(Boolean),
    }));
    sendJson(res, 200, { ...ad, videos });
  } catch (err) {
    sendJson(res, 502, { error: err.message || String(err) });
  }
}

async function handleStream(req, res, url) {
  const target = url.searchParams.get('u');
  if (!target || !isAllowedMediaUrl(target)) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad or disallowed media URL');
    return;
  }

  const name = (url.searchParams.get('name') || 'facebook-ad.mp4').replace(/[^\w.\-]/g, '_');
  const inline = url.searchParams.get('inline') === '1';

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        'user-agent': UA,
        // fbcdn hands back 403 for requests with no plausible origin.
        referer: 'https://www.facebook.com/',
        origin: 'https://www.facebook.com',
        accept: '*/*',
        ...(req.headers.range ? { range: req.headers.range } : {}),
      },
    });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain' }).end(`Upstream fetch failed: ${err.message}`);
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    res
      .writeHead(upstream.status, { 'content-type': 'text/plain' })
      .end(`Facebook CDN returned HTTP ${upstream.status}. The signed link may have expired — re-fetch the ad.`);
    return;
  }

  const headers = {
    'content-type': upstream.headers.get('content-type') || 'video/mp4',
    'accept-ranges': 'bytes',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
  };
  for (const key of ['content-length', 'content-range']) {
    const value = upstream.headers.get(key);
    if (value) headers[key] = value;
  }

  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Unauthenticated so hosting platforms can health-check the app.
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  if (!isAuthed(req, url)) {
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 401, { error: 'Not authorised. Open the app and enter the password.' });
      return;
    }
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_PAGE);
    return;
  }

  // A correct ?key= is exchanged for a cookie, so the secret leaves the URL bar.
  if (PASSWORD && url.searchParams.get('key')) {
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    url.searchParams.delete('key');
    res.writeHead(302, {
      'set-cookie': `${COOKIE}=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure}`,
      location: url.pathname + (url.search || ''),
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/resolve') return void handleResolve(req, res);
  if (req.method === 'GET' && url.pathname === '/api/stream') return void handleStream(req, res, url);
  if (req.method === 'GET') return void serveStatic(req, res, url.pathname);

  res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed');
});

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  console.log(`\n  Facebook ad video downloader`);
  console.log(`    this computer   http://localhost:${PORT}`);
  if (lan) console.log(`    same wi-fi      http://${lan}:${PORT}   <- open this on your phone`);
  console.log(PASSWORD ? '    password gate   on\n' : '    password gate   off (set ACCESS_PASSWORD before exposing this)\n');
});
