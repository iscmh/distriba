#!/usr/bin/env node
/**
 * Terminal version:  node cli.js <ads-library-url> [-o out.mp4] [--sd] [--all]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { resolveAd, suggestFilename, UA } from './src/extract.js';

const argv = process.argv.slice(2);
const flags = new Set();
const options = {};
const positionals = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '-o' || arg === '--out') options.out = argv[++i];
  else if (arg.startsWith('-')) flags.add(arg);
  else positionals.push(arg);
}
const flag = (name) => flags.has(name);
const input = positionals[0];
const help = flag('-h') || flag('--help');

if (!input || help) {
  console.log(`
  fb-ad-dl — download the video from a Facebook Ads Library ad

    node cli.js "https://www.facebook.com/ads/library/?id=1703936547635791"

  Options
    -o <file>   output path (default: ./fb-ad-<id>-hd.mp4)
    --sd        grab the SD rendition instead of HD
    --all       download every creative in the ad, not just the first
`);
  process.exit(help ? 0 : 1);
}

async function download(url, dest) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.facebook.com/', accept: '*/*' },
  });
  if (!res.ok) throw new Error(`CDN returned HTTP ${res.status} for ${dest}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return fs.statSync(dest).size;
}

const wantSd = flag('--sd');
const outOption = options.out || null;

try {
  const ad = await resolveAd(input);
  console.log(`Ad ${ad.adId ?? '(direct link)'}${ad.pageName ? ` — ${ad.pageName}` : ''}: ${ad.videos.length} video(s)`);

  const picked = flag('--all') ? ad.videos : ad.videos.slice(0, 1);
  for (const [i, video] of picked.entries()) {
    const quality = wantSd && video.sd ? 'sd' : video.hd ? 'hd' : 'sd';
    const url = quality === 'sd' ? video.sd : video.hd;
    if (!url) continue;

    const dest =
      outOption && picked.length === 1
        ? outOption
        : path.join(outOption ? path.dirname(outOption) : '.', suggestFilename(ad.adId, i, quality));

    process.stdout.write(`  ↓ ${path.basename(dest)} … `);
    const bytes = await download(url, dest);
    console.log(`${(bytes / 1e6).toFixed(1)} MB`);
  }
} catch (err) {
  console.error(`\n  ✖ ${err.message}\n`);
  process.exit(1);
}
