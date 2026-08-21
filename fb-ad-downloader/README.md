# Facebook Ad Video Downloader

Paste a link from the Facebook Ads Library, get the ad's creative as an `.mp4`.

```
https://www.facebook.com/ads/library/?id=1703936547635791   →   fb-ad-1703936547635791-hd.mp4
```

No dependencies, no build step — just Node 18+.

## Run it

```bash
cd fb-ad-downloader
npm start
```

It prints two URLs:

```
  Facebook ad video downloader
    this computer   http://localhost:4321
    same wi-fi      http://192.168.1.24:4321   <- open this on your phone
    password gate   off (set ACCESS_PASSWORD before exposing this)
```

Paste the link, hit **Fetch video**, preview it inline, download HD or SD.

## Getting to it from your phone

Three options, cheapest first.

### 1. Same wi-fi — nothing to set up

Your phone and computer on the same network: just open the `same wi-fi` URL
that `npm start` printed. Done. Works only while you're on that network and the
computer is awake.

### 2. A public URL, computer stays on — tunnel

Gives you an `https://something.trycloudflare.com` link that works from
anywhere, on cellular. No account needed.

```bash
brew install cloudflared          # or: https://github.com/cloudflare/cloudflared/releases

# terminal 1 — password first, the URL is public
ACCESS_PASSWORD='pick-something' npm start
# terminal 2
npm run tunnel
```

`cloudflared` prints the public URL. Open it on your phone, enter the password
once, and it's remembered for 30 days. The link dies when you stop the tunnel.

### 3. Always online — deploy it

Then your computer can be off entirely.

**Render** (free tier, uses the `render.yaml` at the repo root): New → Blueprint →
point it at this repo → set `ACCESS_PASSWORD` when prompted. You get a permanent
`https://<name>.onrender.com`. Free instances sleep after ~15 min idle, so the
first request takes ~30s to wake.

**Anything Docker** (Fly.io, Railway, a VPS) — there's a `Dockerfile`:

```bash
docker build -t fb-ad-dl fb-ad-downloader
docker run -p 8080:8080 -e ACCESS_PASSWORD='pick-something' fb-ad-dl
```

⚠️ **A hosted instance talks to Facebook from a datacenter IP**, which Facebook
gates far more aggressively than a home connection — expect some ads to come
back as "no video found" there when they resolve fine locally. If that happens,
set `FB_COOKIE` (below). Option 2 doesn't have this problem, because the request
still leaves from your own network.

## Put a password on it before exposing it

Set `ACCESS_PASSWORD` and the whole app — UI, resolver, and the download proxy —
sits behind a password prompt. Without it, anyone who finds the URL can use your
server to pull files. It's off by default so local use stays frictionless, and
`/healthz` stays open so hosting platforms can probe it.

## Or use the CLI

```bash
node cli.js "https://www.facebook.com/ads/library/?id=1703936547635791"
node cli.js 1703936547635791 -o creative.mp4     # bare ad ID works too
node cli.js "<url>" --sd                          # smaller SD rendition
node cli.js "<url>" --all                         # every creative in a carousel ad
```

## What it accepts

- a full Ads Library URL (`.../ads/library/?id=...`)
- a bare numeric ad ID
- a direct `fbcdn.net` `.mp4` link

## How it works

The Ads Library page ships the ad payload as JSON embedded in the HTML, so
`src/extract.js` fetches the page with a browser-like `User-Agent` and pulls the
`video_hd_url` / `video_sd_url` values straight out of it. The server then
streams those bytes back to you (`/api/stream`) rather than linking the CDN URL
directly — that adds the `Referer` fbcdn expects, sets `Content-Disposition` so
the browser saves an `.mp4` instead of playing it, and sidesteps CORS.

## If an ad won't resolve

Facebook occasionally serves a JS-only shell instead of the embedded payload.
Two escape hatches, in order of effort:

1. **Cookie** — copy the `Cookie` header from a logged-in facebook.com request and
   export it: `FB_COOKIE='...' npm start`
2. **Headless browser fallback** — install the optional dependency and the
   resolver will render the page when the plain fetch comes up empty:
   ```bash
   npm i playwright && npx playwright install chromium
   ```
   Force it with `FB_BROWSER_FALLBACK=always`, or turn it off with `never`.
   Note the `Dockerfile` doesn't include this — it's for local runs.

Image-only ads have no video and will report that plainly.

fbcdn links are signed and expire, so a download that 403s just needs the ad
re-fetched to mint fresh URLs.

## Tests

```bash
npm test
```

Boots the real server with `fetch` stubbed. Covers URL parsing, JSON extraction,
download headers, filename sanitising, the host allowlist that keeps
`/api/stream` from acting as an open proxy, and the password gate.

## Config

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4321` | web UI port |
| `HOST` | `0.0.0.0` | bind address (all interfaces, so phones on your wi-fi can reach it) |
| `ACCESS_PASSWORD` | – | shared password; set this whenever the app is reachable from the internet |
| `FB_COOKIE` | – | cookie header for gated ads |
| `FB_BROWSER_FALLBACK` | `auto` | `auto` \| `always` \| `never` |
