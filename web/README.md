# PHT

A daily habit tracker as a Windows 98 desktop with 80s hardware inside: a
"PHT-6" deck of latching keys, LED meters and 7-segment streak counters, a
30-day History matrix with the notes on a cassette J-card, a 7-day weather
tuner, and AI Wire: one AI article a day on teletype paper (Read, Skip, the
past week). One check per habit per day, an optional one-line note, and
streaks. A habit can be daily, every other day or on chosen weekdays; its rest
days show REST and never break a streak.
Any of the last 30 days can be filled in after the fact, from History's LEDs
or by stepping the deck back a day (◀ ▶ or [ ]).

On a desktop the four windows sit on a 12 × 10 snap grid and never overlap:
drag a window by its title bar into free space, or onto another window to swap
the two; pull any edge or corner to resize (sizes snap to cells and stop at
neighbors, 3 × 3 at least); double-click a title bar to fill the free space
above and below. Start → Layouts has four presets (Three columns, History wide,
Today + History with Weather strip, Corners); Start → Reset layout is Three
columns. Each window's contents adapt to its size.

If dragging misbehaves in a browser, open the site with `?debug=drag`: a "Drag
log" window records every pointer and mouse event and what the drag code made
of it; Copy log puts it on the clipboard.

This folder is the web page. The API, the database and the deploy scripts are
in `../api`.

## Local preview

Two terminals: the real API over an in-memory store, and the page's dev server,
which proxies `/api` to it so everything is same-origin like production.

```bash
# terminal 1: the API on 127.0.0.1:4100; prints the dev login
cd ../api && npm install && npm run dev:fake

# terminal 2: the page on http://127.0.0.1:5173
npm install && npm run dev
```

The data resets whenever `dev:fake` restarts.

## Check it

```bash
npm test          # unit tests: dates, routes, API client, the snap grid, keys, the shared store
npm run ui:check  # build, then a headless-Chrome walkthrough with screenshots,
                  # and the snap-grid checks in Chrome and Firefox
npm run ui:check:firefox  # the walkthrough in Firefox (npx playwright-core install firefox first)
```

## Build

```bash
npm run build     # → dist/: index.html, assets/, vendor/98css/, vendor/dseg/, icons/, manifest
```

## Install on an iPhone

Open the site in Safari → Share → Add to Home Screen. It opens full-screen as
"PHT". The icons are drawn by `node scripts/make-icons.mjs`.

Deploy only with `api/ops/pht-deploy-frontend.sh` (see `../docs/DEPLOY.md`).

98.css © Jordan Scales (MIT); the MS Sans Serif font is CC BY-SA 3.0; see
`public/vendor/98css/`.
