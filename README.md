# Archive YouTube Backlink

A fast, single-file web app that **generates YouTube backlink URLs** from a remote template list and **archives each backlink** via:

- **Wayback Machine** (`web.archive.org/save`)
- **archive.today family** — one **random TLD per backlink** chosen from:  
  `archive.today`, `archive.li`, `archive.vn`, `archive.fo`, `archive.md`, `archive.ph`, `archive.is`

Everything runs **client-side** (Vanilla JS). No server, no build step.

---

## Features

- **Paste YouTube URL or 11-char video ID** → auto-extract ID → canonicalise to `https://www.youtube.com/watch?v=ID`
- **Fetch YouTube backlink templates** from a remote JSON and expand placeholders
- **Archive runners**:
  - **IFRAME (default)** — visible grid (nice for monitoring)
  - **Popup** or **Tab** — with **fresh** (open→go→wait→close) or **reuse** modes
- **Concurrency control** — run multiple archive tasks in parallel
- **3-minute rule** — mark success on `load`, otherwise timeout as failure
- **Shuffle order** and optional **Repeat after completion**
- **Shareable URL** — `?VIDEOID` auto-starts with the provided video
- **Download backlinks** — one-per-line `.txt` of original backlink URLs (not the archive wrappers)
- **Persisted settings** — saved in `localStorage`
- **Mobile-friendly**, keyboard accessible UI

---

## 🌐 Live Demo

Try the online tool here:  
- 🔗 [Live Demo](https://backlink-generator-tool.github.io/archive-youtube-backlink/index.html)
