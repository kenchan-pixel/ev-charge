# EV Charge Calculator

A small browser-based EV charging calculator (EV 充電計算器). All logic runs entirely in the browser.

## Live site

- **GitHub Pages (primary):** https://kenchan-pixel.github.io/ev-charge/
- **Netlify (fallback):** https://ev-charge-calculator.netlify.app/

Both serve the same files. The Netlify deployment is intentionally kept as a fallback.

## Privacy

No backend, no analytics, no tracking, no cookies. The only network request is a Google Fonts stylesheet. Your calculator settings are saved **only in your own browser** (`localStorage`) and never leave your device.

## Hosting / build

Pure static site — a single `index.html` (inline CSS + JS) plus a web manifest and icons. **No build step.**

- GitHub Pages serves the `master` branch from the repo root (`/`).
- All asset paths are relative, so the same files work under both `/` (Netlify) and `/ev-charge/` (GitHub Pages) with no changes.
