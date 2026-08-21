# Facebook Ad Video Downloader

Paste a link from the Facebook Ads Library, get the ad's creative as an `.mp4`.

```
https://www.facebook.com/ads/library/?id=1703936547635791   →   fb-ad-1703936547635791-hd.mp4
```

No dependencies, no build step — just Node 18+.

## Run the web UI

```bash
cd fb-ad-downloader
npm start          # → http://localhost:4321
```

Paste the link, hit **Fetch video**, preview it inline, then download HD or SD.

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

Image-only ads have no video and will report that plainly.

Note that the fbcdn links are signed and expire after a while — if a download
returns a 403, re-fetch the ad to mint fresh URLs.

## Tests

```bash
npm test
```

Boots the real server with `fetch` stubbed, and covers URL parsing, JSON
extraction, download headers, filename sanitising, and the host allowlist that
keeps `/api/stream` from acting as an open proxy.

## Config

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4321` | web UI port |
| `FB_COOKIE` | – | cookie header for gated ads |
| `FB_BROWSER_FALLBACK` | `auto` | `auto` \| `always` \| `never` |
