# Map workspace benchmark harness

`bench.mjs` drives a real Chromium (via Playwright) against the running dev
stack and measures the map workspace's hot path: loading
`/projects/:projectId/map` and, for the `pan` scenario, panning around once
loaded. It is the measurement foundation for the loading-performance
session — later optimization tasks are judged against a baseline captured
with this tool.

## Prerequisites

- Backend running on `http://localhost:1316` (`cd backend && ./.venv/Scripts/python.exe -m uvicorn ...` — already up in dev).
- Vite dev server running on `http://localhost:1317` (`npm run dev`).
- Chromium installed for Playwright (one-time): `npx playwright install chromium`.
- Bench data seeded (idempotent, ~a minute for the 1M layer):
  ```sh
  cd backend && ./.venv/Scripts/python.exe scripts/bench.py seed
  ```
  This creates a `Benchmarks` project with 10K / 100K / 1M point layers.

## Usage

Run from `web/`:

```sh
npm run bench -- --scenario cold
npm run bench -- --scenario warm
npm run bench -- --scenario pan
```

Flags:

- `--scenario cold|warm|pan` (default `cold`)
- `--project "Benchmarks"` — project name to resolve via `GET /api/v1/projects` (default `Benchmarks`)
- `--url http://localhost:1317` — base URL of the running Vite dev server (default shown)

Each run writes `bench/results/<scenario>-<runstamp>.json` and prints a
summary table. `bench/results/` and `bench/.profiles/` are gitignored —
never commit a run's output or browser profile.

## Scenarios

- **cold** — fresh Chromium profile per run (`bench/.profiles/cold-<timestamp>`),
  so no prior IndexedDB or HTTP cache. Measures a first-ever visit.
- **warm** — reuses a single profile dir (`bench/.profiles/warm`) across
  invocations, so IndexedDB and the HTTP cache persist between runs.
  **The first `warm` run only populates the profile** (it still measures
  something, but it's effectively another cold run because the profile
  started empty). Run it a second time to measure the actually-warm state
  the metric name implies.
- **pan** — same fresh-profile load as `cold`, then a scripted pan: 5
  animated moves between two anchors ~50km apart, using the page's live OL
  `View` (accessed through the app's dev-only `window.__olMap` hook — see
  `src/map/MapCanvas.tsx`). Captures frame timing and settle latency during
  the pan in addition to the load metrics.

## Metrics

| Field              | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `initialLoadMs`     | navigation start → first OL `rendercomplete` (the `graticule:first-render` performance mark)     |
| `panP95FrameMs`     | p95 of rAF-to-rAF frame deltas during the scripted pan (`pan` scenario only, else `null`)         |
| `moveSettleP95Ms`   | p95 of moveend → next `rendercomplete`, one sample per scripted move (`pan` scenario only, `null` if none settled — see Notes) |
| `usedJSHeapMB`      | `performance.memory.usedJSHeapSize` in MB (Chromium launched with `--enable-precise-memory-info`) |
| `networkBytes`      | sum of CDP `Network.loadingFinished` `encodedDataLength` for the whole run                        |
| `longTasks`         | `{ count, maxMs }` from a buffered `PerformanceObserver('longtask')` over the whole run            |
| `geoCache`          | `window.__geoCache.metrics()` verbatim, or `null` if `__geoCache` doesn't exist yet                |

`geoCache` is `null` today — a later task introduces `window.__geoCache`.
Once it exists, its `metrics()` output is captured here unmodified.

## Notes

- The harness never gets its own OpenLayers instance; the `pan` scenario
  drives the app's real map via `window.__olMap`, which `MapCanvas.tsx`
  exposes only in dev builds (`import.meta.env.DEV`) — never in production.
- `initialLoadMs` is computed from the browser's own Navigation Timing /
  User Timing entries (not Node wall-clock time around `page.goto()`), so it
  isn't inflated by Playwright's own IPC round-trip.
- Against the seeded 1M-point bench layer, `moveSettleP95Ms` (and sometimes
  the whole `moveSettleTimes` sample) can come back `null`: panning into a
  fresh viewport can kick off a feature/tile load whose `loadend` never
  arrives within the harness's poll budget, so the map's "not loading"
  state — and therefore `rendercomplete` — never recurs after the first
  move. That is a real characteristic of the current (pre-optimization)
  loading path under heavy layers, observed and documented during
  verification, not a bug in the harness. `panP95FrameMs` is unaffected and
  is still captured from the live rAF loop.
