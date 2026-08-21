// End-to-end test with Facebook stubbed out: boots the real server against a mocked fetch.
// Run with: npm test
process.env.PORT = '4399';
process.env.FB_BROWSER_FALLBACK = 'never';

const FIXTURE = `<script type="application/json">{"page_name":"Acme Co","video_hd_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/t42\\/hd1.mp4?oh=1","video_sd_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/t42\\/sd1.mp4","video_preview_image_url":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/p.jpg"}</script>`;
const BODY = Buffer.from('FAKE-MP4-BYTES'.repeat(10));

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('127.0.0.1:4399')) return realFetch(url, init);
  if (u.includes('facebook.com/ads/library')) {
    return new Response(FIXTURE, { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (u.includes('fbcdn.net')) {
    if (!init.headers?.referer) throw new Error('expected referer header');
    return new Response(BODY, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(BODY.length) },
    });
  }
  throw new Error('unexpected fetch: ' + u);
};

await import('../server.js');
await new Promise((r) => setTimeout(r, 300));

const base = 'http://127.0.0.1:4399';
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <- ' + extra}`);
  if (!cond) failures += 1;
};

// UI
const home = await fetch(base + '/');
check('GET / serves the UI', home.status === 200 && (await home.text()).includes('Facebook Ad Video Downloader'));

// traversal
const trav = await fetch(base + '/../server.js');
check('path traversal blocked', [403, 404].includes(trav.status), 'status ' + trav.status);

// resolve
const r = await fetch(base + '/api/resolve', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://www.facebook.com/ads/library/?id=1703936547635791' }),
});
const ad = await r.json();
check('resolve returns 200', r.status === 200, JSON.stringify(ad));
check('adId parsed', ad.adId === '1703936547635791');
check('page name parsed', ad.pageName === 'Acme Co');
check('one video, two qualities', ad.videos.length === 1 && ad.videos[0].downloads.length === 2, JSON.stringify(ad.videos));
check('filename suggested', ad.videos[0].downloads[0].filename === 'fb-ad-1703936547635791-hd.mp4');

// resolve error
const bad = await fetch(base + '/api/resolve', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com/x' }),
});
check('bad input -> 502 + message', bad.status === 502 && (await bad.json()).error.includes('Ads Library'));

// stream download
const dl = await fetch(base + '/api/stream?u=' + encodeURIComponent(ad.videos[0].downloads[0].url) + '&name=out.mp4');
const buf = Buffer.from(await dl.arrayBuffer());
check('stream returns bytes', dl.status === 200 && buf.length === BODY.length, `${dl.status} ${buf.length}`);
check('attachment disposition', dl.headers.get('content-disposition') === 'attachment; filename="out.mp4"', dl.headers.get('content-disposition'));
check('content-type video/mp4', dl.headers.get('content-type') === 'video/mp4');

// inline preview
const pv = await fetch(base + '/api/stream?inline=1&u=' + encodeURIComponent(ad.videos[0].downloads[0].url) + '&name=p.mp4');
await pv.arrayBuffer();
check('inline disposition', pv.headers.get('content-disposition').startsWith('inline;'));

// open-proxy guard
const evil = await fetch(base + '/api/stream?u=' + encodeURIComponent('https://evil.example.com/a.mp4'));
check('non-fbcdn host rejected', evil.status === 400, 'status ' + evil.status);
await evil.text();

// filename sanitising
const nasty = await fetch(base + '/api/stream?u=' + encodeURIComponent(ad.videos[0].downloads[0].url) + '&name=' + encodeURIComponent('a"; x=../../evil.mp4'));
await nasty.arrayBuffer();
const nastyName = nasty.headers.get('content-disposition').split('filename=')[1].replace(/^"|"$/g, '');
check('filename sanitised', !/["\/;]/.test(nastyName), nastyName);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green');
process.exit(failures ? 1 : 0);
