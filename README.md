# EV Charge Calculator

A small browser-based EV charging calculator (EV 充電計算器). All logic runs entirely in the browser.

## Project status

This project has reached a practical, stable version suitable for ongoing use. Active feature development is paused for now so the calculator can remain simple and reliable over the long term.

Maintenance will focus on keeping the existing tool available and working, including essential bug fixes, browser compatibility updates, security-related maintenance, and hosting recovery when needed. New feature development will resume only when there is a clear practical requirement.

## Live site

- **GitHub Pages (primary):** https://kenchan-pixel.github.io/ev-charge/
- **Netlify (fallback):** https://ev-charge-calculator.netlify.app/

Both serve the same files. The Netlify deployment is intentionally kept as a fallback.

## Privacy

No backend, no analytics, no tracking, no cookies. The only network request is a Google Fonts stylesheet. Your calculator settings are saved **only in your own browser** (`localStorage`) and never leave your device.

## Hosting / build

Pure static site — `index.html`, a dependency-free `calculation-core.js`, a web manifest, and icons. **No build step.**

- GitHub Pages serves the `master` branch from the repo root (`/`).
- All asset paths are relative, so the same files work under both `/` (Netlify) and `/ev-charge/` (GitHub Pages) with no changes.

## Calculation core

`calculation-core.js` contains the formulas and input validation without reading or changing the DOM. It exposes `EVChargeCore` to the browser and the same API through CommonJS for Node's built-in test runner. `index.html` remains the UI adapter: it collects values, calls the core, displays the result, and preserves the existing `localStorage` keys.

`calculateCharge(input)` accepts the calculation mode, battery capacity, efficiency, current charge, either wall energy or target charge, charging speed, and electricity price. It returns validation status plus final charge, wall energy, battery energy, duration, cost, and the existing high-charge warning.

`estimateCapacity(input)` accepts one charging record (start/end SOC, wall energy, and efficiency) plus the current reference capacity. It returns estimated usable capacity, the ratio to the reference capacity, SOC change, and the existing confidence guidance.

### Formula assumptions

- Amount mode: **battery energy = wall energy × efficiency**, then final SOC is current SOC plus battery energy divided by usable capacity.
- Target mode: required battery energy is usable capacity multiplied by the SOC increase; **required wall energy = required battery energy ÷ efficiency**.
- Duration is wall energy divided by the entered average charging power. Cost is wall energy multiplied by the entered unit price.
- Capacity estimate: **estimated capacity = wall energy × efficiency ÷ SOC change** (where SOC change is expressed as a decimal).
- SOC is treated as a linear estimate. The calculator does not invent a universal battery curve; the existing 90% and 95% messages warn that charging can slow near full.
- Valid charge percentages include 0% and 100%. Requests below 0%, above 100%, below the current SOC, or with invalid capacity, efficiency, speed, price, or energy are rejected.

## Automated validation

The checks use Node.js built-ins and the installed Chrome browser. No package install is required.

```powershell
node --check calculation-core.js
node --test

$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/browser-smoke.js
```

On Linux / GitHub Actions, use:

```bash
CHROME_PATH=/usr/bin/google-chrome node tests/browser-smoke.js
```

The browser smoke starts an ephemeral local server and isolated browser profile, verifies both calculation modes, invalid input, capacity estimation, `localStorage`, relative paths, and a 390 px mobile viewport, then stops the browser and removes the temporary profile. `.github/workflows/validate.yml` runs syntax checks, the Node test suite, and this browser smoke for every pull request and every update to `master`.

## Maintenance workflow

1. Add or update a public-behavior test before changing a formula or validation rule, and confirm the new test fails for the intended reason.
2. Make the smallest core change, then run `node --check calculation-core.js` and `node --test`.
3. Run `node tests/browser-smoke.js` with `CHROME_PATH` set and manually inspect the affected desktop/mobile flow when UI wiring changes.
4. Open a pull request and require the `Validate` workflow to pass on its exact head before review or merge.
5. Keep `ev-calculator-v22`, `evcalc_theme`, manifest/icon paths, and all local asset paths stable unless a separately approved migration explicitly changes them.

Merging `master` publishes the primary GitHub Pages site. Treat that merge as a production deployment decision, separate from implementation and review approval.
