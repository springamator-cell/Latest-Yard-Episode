# Latest Ludwig Videos — a Stremio addon

Adds a **Ludwig** row to Stremio with one tile that always plays Ludwig's newest video from his
official YouTube channel (@ludwig). The nine videos before it are listed under it.

Every hour, GitHub checks the channel's uploads (Shorts are skipped) and republishes the
addon on GitHub Pages. Nothing is re-hosted; videos play through Stremio's YouTube support.

## Install

Open this repo's GitHub Pages site and tap **Install in Stremio**, or paste
`https://springamator-cell.github.io/Latest-Yard-Episode/manifest.json` into Stremio's addon
search box.

## Notes

- GitHub pauses scheduled runs after 60 days without repo activity. If it stops updating,
  open Actions → "Update and publish addon" → Run workflow.
