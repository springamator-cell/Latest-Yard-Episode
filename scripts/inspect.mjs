const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };
const html = await (await fetch('https://www.youtube.com/@TheYardPodcast/videos', { headers: H })).text();
console.log('len', html.length);
for (const k of ['videoRenderer', 'lockupViewModel', 'richItemRenderer', 'contentId', '"videoId"', 'shortsLockupViewModel', 'gridVideoRenderer']) console.log(k, html.split(k).length - 1);
const i = html.indexOf('richItemRenderer');
console.log('SNIP', html.slice(i, i + 1500).replace(/\s+/g, ' '));
