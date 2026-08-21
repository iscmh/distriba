#!/usr/bin/env node
/**
 * Tiny zero-dependency server for the Facebook ad video downloader.
 *
 *   GET  /                     the UI
 *   POST /api/resolve          { url } -> ad metadata + direct mp4 links
 *   GET  /api/stream?u=&name=  proxies the fbcdn bytes (download or preview)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { resolveAd, isAllowedMediaUrl, suggestFilename, UA } from './src/extract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT || 4321);

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

  if (req.method === 'POST' && url.pathname === '/api/resolve') return void handleResolve(req, res);
  if (req.method === 'GET' && url.pathname === '/api/stream') return void handleStream(req, res, url);
  if (req.method === 'GET') return void serveStatic(req, res, url.pathname);

  res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  Facebook ad video downloader running at http://localhost:${PORT}\n`);
});
