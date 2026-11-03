// Builds the "Latest Yard Episode" Stremio addon as static files in dist/.
// It finds The Yard's official YouTube channel, takes its newest full episodes
// (Shorts are skipped) and publishes them so Stremio plays them through YouTube.
// GitHub Actions runs this every hour and hosts dist/ on GitHub Pages.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const OUT = 'dist';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const CHANNEL_PATHS = ['@TheYardPodcast'];
const CHANNEL_NAME = 'The Yard';
const EPISODES = 10;
const CACHE_SECONDS = 1800;
const ITEM_ID = 'yard-latest';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+1; SOCS=CAI'
};

async function get(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const jsonString = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };

function metaTag(html, attr, name) {
  const m = html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`));
  return m ? decode(m[1]) : null;
}

function findChannelId(html) {
  for (const p of [
    /"externalId":"(UC[\w-]{22})"/,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /"channelId":"(UC[\w-]{22})"/
  ]) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}

async function channelAt(p) {
  const html = await get(`https://www.youtube.com/${p}`, 2);
  const id = findChannelId(html);
  const name = metaTag(html, 'property', 'og:title');
  if (!id) return null;
  return { id, name, avatar: metaTag(html, 'property', 'og:image'), url: `https://www.youtube.com/${p}` };
}

async function findChannel() {
  if (process.env.CHANNEL_ID) return channelAt(`channel/${process.env.CHANNEL_ID}`);
  for (const p of CHANNEL_PATHS) {
    try {
      const c = await channelAt(p);
      console.log(`  ${p}: ${c ? `${c.name} (${c.id})` : 'no channel'}`);
      if (c && c.name === CHANNEL_NAME) return c;
    } catch (e) {
      console.log(`  ${p}: ${e.message}`);
    }
  }
  // Fall back to YouTube's channel search for a channel named exactly "The Yard".
  const html = await get('https://www.youtube.com/results?search_query=the+yard+podcast&sp=EgIQAg%253D%253D');
  for (const m of html.matchAll(/"channelRenderer":\{"channelId":"(UC[\w-]{22})","title":\{"simpleText":"((?:[^"\\]|\\.)*)"/g)) {
    console.log(`  search: ${jsonString(m[2])} (${m[1]})`);
    if (jsonString(m[2]) === CHANNEL_NAME) return channelAt(`channel/${m[1]}`);
  }
  throw new Error("couldn't find The Yard's YouTube channel");
}

// Official RSS feed of the channel's uploads. Shorts are linked as /shorts/ and skipped.
async function fromFeed(channelId) {
  const xml = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries
    .filter((e) => !/\/shorts\//.test(e))
    .map((e) => ({
      id: (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1],
      title: decode((e.match(/<title>([^<]*)<\/title>/) || [])[1] || ''),
      published: (e.match(/<published>([^<]+)<\/published>/) || [])[1]
    }))
    .filter((v) => v.id);
}

// Fallback when the feed is down: the channel's Videos tab (Shorts live on a separate tab).
async function fromVideosTab(channelUrl) {
  const html = await get(`${channelUrl}/videos`);
  const out = [];
  const seen = new Set();
  const add = (id, title) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, title: jsonString(title || 'Episode'), published: null });
  };
  for (const m of html.matchAll(/"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,4000}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g)) add(m[1], m[2]);

  // Newer layout: each video is a {"lockupViewModel":{...}} entry with a contentId and a
  // metadata title. Read each entry on its own so fields can come in any order.
  const marker = '{"lockupViewModel":{';
  const starts = [];
  for (let i = html.indexOf(marker); i >= 0; i = html.indexOf(marker, i + 1)) starts.push(i);
  starts.forEach((s, n) => {
    const entry = html.slice(s, starts[n + 1] ?? s + 20000);
    if (/LOCKUP_CONTENT_TYPE_SHORT|"shorts/i.test(entry)) return;
    const id = (entry.match(/"contentId":"([\w-]{11})"/) || [])[1];
    const title = (entry.match(/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/) ||
      entry.match(/"title":\{"content":"((?:[^"\\]|\\.)*)"/) || [])[1];
    add(id, title);
  });
  return out;
}

async function previousStreams() {
  if (!BASE_URL) return [];
  try {
    const data = JSON.parse(await get(`${BASE_URL}/stream/tv/${ITEM_ID}.json`, 1));
    return (data.streams || []).filter((s) => s.ytId);
  } catch {
    return [];
  }
}

function shortDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
}

async function write(file, data) {
  const full = path.join(OUT, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, typeof data === 'string' ? data : JSON.stringify(data));
}

await rm(OUT, { recursive: true, force: true });

const channel = await findChannel();
console.log(`Channel: ${channel.name} (${channel.id})`);

let episodes = [];
try {
  episodes = await fromFeed(channel.id);
  console.log(`Feed: ${episodes.length} videos`);
} catch (e) {
  console.log(`Feed unavailable (${e.message}); trying the Videos tab`);
}
if (!episodes.length) {
  try {
    episodes = await fromVideosTab(channel.url);
    console.log(`Videos tab: ${episodes.length} videos`);
  } catch (e) {
    console.log(`Videos tab unavailable (${e.message})`);
  }
}

let streams = episodes.slice(0, EPISODES).map((v, i) => ({
  ytId: v.id,
  name: i === 0 ? '▶ Latest' : 'The Yard',
  title: v.published ? `${v.title}\n${shortDate(v.published)}` : v.title
}));
if (!streams.length) {
  streams = await previousStreams();
  console.log(`Reused ${streams.length} episodes from the last update`);
}
if (!streams.length) throw new Error('no episodes found; keeping the previous version online');

streams.push({ externalUrl: `${channel.url}/videos`, name: 'YouTube', title: 'Open The Yard on YouTube' });

const latest = streams[0];
const latestTitle = latest.title.split('\n')[0];
console.log(`Latest: ${latestTitle}`);

const thumb = `https://i.ytimg.com/vi/${latest.ytId}/hqdefault.jpg`;
const meta = {
  id: ITEM_ID,
  type: 'tv',
  name: 'The Yard — Latest Episode',
  poster: thumb,
  posterShape: 'landscape',
  background: `https://i.ytimg.com/vi/${latest.ytId}/maxresdefault.jpg`,
  logo: channel.avatar || undefined,
  releaseInfo: latest.title.split('\n')[1] || 'Latest',
  description: `Newest episode: ${latestTitle}. Earlier episodes are listed below it.`
};

await write('manifest.json', {
  id: 'community.springamator.latestyard',
  version: '1.0.0',
  name: 'Latest Yard Episode',
  description: 'Plays the newest episode of The Yard from its official YouTube channel.',
  logo: channel.avatar || undefined,
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  idPrefixes: ['yard-'],
  catalogs: [{ type: 'tv', id: 'the-yard', name: 'The Yard' }],
  behaviorHints: { configurable: false, configurationRequired: false }
});
await write('catalog/tv/the-yard.json', { metas: [meta], cacheMaxAge: CACHE_SECONDS });
await write(`meta/tv/${ITEM_ID}.json`, { meta, cacheMaxAge: CACHE_SECONDS });
await write(`stream/tv/${ITEM_ID}.json`, { streams, cacheMaxAge: CACHE_SECONDS });

const manifestUrl = `${BASE_URL}/manifest.json`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
await write('index.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Latest Yard Episode</title>
<style>
:root{color-scheme:light dark;--bg:#0f1011;--fg:#f1f1f1;--mut:#a3a3a3;--acc:#f4c430;--card:#1b1c1e}
@media (prefers-color-scheme: light){:root{--bg:#f7f6f2;--fg:#151515;--mut:#5f5f5f;--card:#fff;--acc:#b8860b}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}
h1{margin:0 0 4px;font-size:28px}p{color:var(--mut);margin:0 0 20px}
img{width:100%;border-radius:12px;display:block;margin:0 0 12px}
.ep{background:var(--card);border-radius:12px;padding:14px;margin-bottom:20px}
a.btn{display:block;text-align:center;background:var(--acc);color:#000;padding:14px;border-radius:12px;font-weight:600;text-decoration:none}
code{display:block;margin:12px 0;padding:12px;border-radius:10px;background:var(--card);word-break:break-all;font-size:13px}
small{color:var(--mut)}
</style></head><body><main>
<h1>Latest Yard Episode</h1>
<p>A Stremio addon that always has the newest episode of The Yard.</p>
<div class="ep"><img src="${esc(thumb)}" alt=""><strong>${esc(latestTitle)}</strong></div>
<a class="btn" href="${esc(manifestUrl.replace(/^https?:\/\//, 'stremio://'))}">Install in Stremio</a>
<code>${esc(manifestUrl)}</code>
<small>Updated ${esc(new Date().toISOString())} · checks for new episodes every hour</small>
</main></body></html>`);

console.log('Done.');
