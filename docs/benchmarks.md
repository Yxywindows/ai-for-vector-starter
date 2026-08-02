# Map workspace benchmarks

Measurement record for the loading-performance session. This file is the
baseline every later optimization task in the session is judged against.
Numbers here are recorded as observed, including noisy or ugly ones — no
smoothing beyond the median-of-3 reporting described below.

## Methodology

**Machine.** Windows 11 Home, Intel Core i7-13700HX, 32 GB RAM. Local dev
stack, nothing containerized except Postgres:

- Backend: `backend/.venv/Scripts/python.exe -m uvicorn app.main:app --port 1316`,
  confirmed running **without** `--reload` (checked the live process's command
  line at measurement time).
- Frontend: Vite dev server, `npm run dev` from `web/`, on `http://localhost:1317`.
- Database: `postgis/postgis:16-3.4` in Docker (`gis-platform-postgres`
  container, healthy). Flags verified directly in `docker-compose.yml` at
  measurement time (not assumed): `shared_buffers=512MB`, `work_mem=32MB`,
  `random_page_cost=1.1`.
- Browser: Chromium via Playwright 1.62.1, launched by the harness with
  `--enable-precise-memory-info`, viewport 1440x900. Node v24.15.0.

**Dataset.** The seeded `Benchmarks` project
(`fbfb2263-187a-4e57-b34f-385557cf04a0`), created by
`backend/scripts/bench.py seed` (already seeded before this task — not
re-run here). It holds three point vector layers, **all visible
simultaneously** in the map workspace (`/projects/:projectId/map` renders
every visible layer of the project at once, so every browser measurement
below reflects all three layers loading/rendering together, not one layer
in isolation):

| Layer            | Features  | Backing table                     |
| ---------------- | --------- | ---------------------------------- |
| Bench 10,000     | 10,000    | `gis_data.bench_points_10000`      |
| Bench 100,000    | 100,000   | `gis_data.bench_points_100000`     |
| Bench 1,000,000  | 1,000,000 | `gis_data.bench_points_1000000`    |

Total 1,110,000 points across the workspace. Each table has a GIST index on
`geometry`, a primary key on `fid`, and fresh statistics (`ANALYZE`) — the
same shape the real import path produces.

**Commands.**

Server-side (from `backend/`, venv active, backend already running):

```sh
./.venv/Scripts/python.exe scripts/bench.py seed      # idempotent; already run before this task, not re-run here
./.venv/Scripts/python.exe scripts/bench.py measure
```

`seed` creates/refreshes the `Benchmarks` project and its 3 layers (see
Dataset above) and is safe to re-run — it was already applied before this
task started, so this task only ran `measure`. This hits
`/api/v1/layers/{id}/tiles/{z}/{x}/{y}.mvt` (6 tiles at z=5 over the seeded
extent, once for "cold" then 5x for "warm"), `/features` (10x, bbox
`95,25,115,40`, `simplify=0.01`), and `/attributes` (10x) per layer, and
prints p50/p95 per metric. Run once; percentiles come from the fixed
in-script sample counts above, not from repeating the whole command.

Browser harness (from `web/`, backend + Vite already running, Chromium
installed via `npx playwright install chromium`). **Before the first run**,
clear any stale state from a previous session — both dirs are gitignored
scratch space, safe to wipe — so the `warm` scenario's populate run below
genuinely starts from an empty profile rather than silently reusing a
profile some earlier session already warmed (a stale-profile failure mode
observed while producing this baseline: `bench/.profiles/warm` had leftover
state from an earlier harness-verification run):

```sh
rm -rf bench/results/*.json bench/.profiles/*
```

Then run each scenario:

```sh
npm run bench -- --scenario cold   # x3, fresh profile per run
npm run bench -- --scenario warm   # 1 populate run, then x3 measured
npm run bench -- --scenario pan    # x3, fresh profile per run
```

- **cold**: fresh `bench/.profiles/cold-<timestamp>` per invocation, so no
  prior IndexedDB or HTTP cache. Run 3 times.
- **warm**: reuses `bench/.profiles/warm` across invocations. The first
  invocation only *populates* that profile's HTTP cache — its own numbers
  are effectively another cold run and are reported separately below, not
  folded into the median. It was run once, then the profile was measured
  3 more times.
- **pan**: fresh profile per run (like cold), then a scripted sequence of 5
  animated `view.animate()` moves ~50km apart via the app's dev-only
  `window.__olMap` hook. Run 3 times.

Each invocation writes one `bench/results/<scenario>-<timestamp>.json`; the
result files backing the tables below are listed in the appendix so every
number is traceable to a run.

**Reporting.** Each table below reports the **median of 3 runs** per
metric (median taken independently per column, not "the run whose overall
profile was most typical"). All raw per-run values are in the collapsed
appendix at the end so variance is visible — some metrics varied a lot
between runs (see Notes under each table).

`usedJSHeapMB` as emitted by the harness is `performance.memory.usedJSHeapSize
/ (1024*1024)` — technically MiB despite the field name.

## Baseline (pre-cache, commit 4e1c287)

Commit `4e1c287` (`4e1c2877b079157bbf0bb9c21918b4ff0f069e6b`,
`fix(bench): explicit timeouts on pan script and project lookup`) is `HEAD`
on `session-1-loading-performance` at the time these numbers were captured —
i.e. immediately before any client-caching work in this session.

### 1. Initial load

| Scenario                | initialLoadMs (median of 3) |
| ------------------------ | --------------------------- |
| cold (fresh profile)     | 832.1 ms                    |
| warm (HTTP cache only)   | 571.6 ms                    |
| warm — populate run only (n=1, not in median) | 892 ms |

Notes: the first cold run (1722.6 ms) was well above the other two
(832.1 ms, 809.1 ms) — plausibly first-hit JIT/module-eval warmup in a
brand-new Chromium profile rather than anything server-side, since
`networkBytes` was byte-for-byte identical (11,184,709 B) across all three
cold runs. "Warm" here means browser HTTP cache only — there is no
IndexedDB/client cache tier yet (see §4).

### 2. Pan/zoom latency

| Metric                        | Median of 3 (pan scenario) |
| ------------------------------ | --------------------------- |
| initialLoadMs (pan's own load) | 931.8 ms                    |
| panP95FrameMs                  | 787.6 ms                    |
| moveSettleP95Ms                | **null in 2 of 3 runs**; the third run measured 17,169.2 ms |

Notes: `moveSettleP95Ms` against the seeded 1M-point layer is a known
pre-optimization characteristic, not a harness bug (see
`web/bench/README.md`): panning into a fresh viewport under this heavy
layer set can start a feature/tile load whose `loadend` never arrives
within the harness's poll budget, so the map's "not loading" state — and
therefore `rendercomplete` — never recurs after the first move, and the
metric comes back `null`. Two of the three runs did exactly that. The third
run instead returned a very large, real value (17,169.2 ms) rather than
`null` — consistent with the same root cause (a long-running load/paint
under main-thread contention; `longTasks.maxMs` hit 5,256 ms in that same
run) surfacing as an extreme delayed settle instead of a total non-settle.
This is reported as-is rather than averaged away: at baseline,
`moveSettleP95Ms` under the 1M layer is **not a reliable metric** — it is
either absent or huge. `panP95FrameMs` (driven by the live rAF loop, not
gated on load completion) is unaffected and rated consistently across all
3 runs (604.6 / 787.6 / 1960.9 ms).

### 3. Memory usage

| Scenario | usedJSHeapMB (median of 3) |
| -------- | --------------------------- |
| cold     | 23.92 MB                    |
| warm     | 24.52 MB                    |
| pan      | 1058.71 MB                  |

Notes: heap usage jumps roughly 40x during/after the scripted pan versus a
static cold/warm load (23–25 MB -> ~1,059 MB in 2 of 3 pan runs). The third
pan run measured only 560.87 MB — heap size at the moment of measurement is
sensitive to whatever the 1M-point layer's feature/tile buffers happened to
hold and whether GC had run, so this is a real, wide spread, not a
transcription error.

### 4. Cache-hit latency

**n/a at baseline.** `window.__geoCache` does not exist yet — every run
recorded `geoCache: null` (verified in all 10 result files, see appendix).
There is no IndexedDB or in-memory client cache tier; "warm" in §1 reflects
only the browser's own HTTP cache. Cache-hit latency as a distinct,
measurable metric family starts once a later task in this session
introduces `window.__geoCache` and its `metrics()` output.

### 5. Network transfer

| Scenario                | networkBytes (median of 3)      |
| ------------------------ | -------------------------------- |
| cold                     | 11,184,709 B (≈ 11.18 MB)        |
| warm (populate run, n=1) | 11,184,709 B (≈ 11.18 MB)        |
| warm (measured)          | 15,788 B (≈ 15.4 KB)             |
| pan                      | 66,753,204 B (≈ 66.75 MB)        |

Notes: all 3 cold runs transferred the *exact* same byte count
(11,184,709 B) — no measurable variance in payload size, only in timing.
The warm populate run is essentially a cold run over the network (same
byte count as cold, as expected for an empty HTTP cache). Of the 3 measured
warm runs, the first transferred 79,355 B versus 15,788 B for the other
two — some extra revalidation/traffic beyond pure cache hits on the first
truly-warm invocation, still ~140x–~710x smaller than a cold load depending
on the run (140.9x for the noisier first measured run, 708.4x for the other
two). Pan
transfers ~6x a cold load's bytes, consistent with the scripted moves
pulling fresh tiles/features for previously-unseen viewport area across all
three layers.

### 6. Main-thread blocking (long tasks)

| Scenario | longTasks.count (median of 3) | longTasks.maxMs (median of 3) |
| -------- | ------------------------------ | ------------------------------- |
| cold     | 2                               | 56 ms                           |
| warm     | 2                               | 55 ms                           |
| pan      | 16                              | 4939 ms                         |

Notes: cold/warm long tasks are small and consistent (all under ~60 ms,
2 tasks each run). Pan is dramatically worse on both axes — 15–17 long
tasks per run and a max single task of up to 5,256 ms (run 1) — reflecting
sustained main-thread work while the 1M-point layer processes the panned
viewport, and directly explains why `moveSettleP95Ms` is unreliable (§2).

### 7. Server-side (`backend/scripts/bench.py measure`)

Single run, printed p50/p95 over the fixed sample counts baked into the
script (6 tiles cold, 30 warm [5x6], 10 feature requests, 10 attribute
requests, per layer):

| Layer         | Tiles cold p50/p95 | Tiles warm p50/p95 | Features p50/p95 | Attributes p50/p95 | Attribute total |
| ------------- | ------------------ | ------------------- | ------------------ | -------------------- | ---------------- |
| 10,000        | 18.5 / 21.8 ms      | 10.2 / 14.5 ms       | 91.1 / 200.2 ms     | 18.6 / 22.5 ms        | 10,000 (exact)     |
| 100,000       | 52.7 / 70.7 ms      | 12.8 / 21.8 ms       | 112.2 / 224.3 ms    | 15.4 / 16.7 ms        | 100,000 (estimated)|
| 1,000,000     | 306.2 / 331.9 ms    | 27.4 / 59.2 ms       | 114.2 / 196.5 ms    | 18.0 / 24.2 ms        | 1,000,000 (estimated)|

Notes: tile latency scales clearly with layer size cold (18.5 -> 52.7 ->
306.2 ms p50) but converges much closer together warm (10.2 -> 12.8 ->
27.4 ms p50), i.e. Postgres's own page cache absorbs most of the size
penalty once warm. Feature-request and attribute-page latency are
comparatively flat across layer sizes — both routes already have a fast
path (bbox-simplified geometry; attribute totals become "estimated" above
some row-count threshold) that keeps p50 in a narrow band regardless of
table size.

## Appendix: raw per-run values

<details>
<summary>Cold (3 runs, browser)</summary>

| timestamp (result file)               | initialLoadMs | usedJSHeapMB | networkBytes | longTasks.count | longTasks.maxMs |
| -------------------------------------- | ------------: | -----------: | -----------: | ---------------: | ----------------: |
| cold-2026-08-02T15-49-52-233Z.json     | 1722.6        | 23.93        | 11,184,709   | 2                 | 61                |
| cold-2026-08-02T15-50-02-646Z.json     | 832.1         | 23.92        | 11,184,709   | 2                 | 56                |
| cold-2026-08-02T15-50-33-349Z.json     | 809.1         | 23.90        | 11,184,709   | 2                 | 56                |

`panP95FrameMs`, `moveSettleP95Ms`, `geoCache` are `null` in all 3 (not
applicable to this scenario / cache doesn't exist).

</details>

<details>
<summary>Warm — populate run (1 run) + measured (3 runs), browser</summary>

| timestamp (result file)               | role      | initialLoadMs | usedJSHeapMB | networkBytes | longTasks.count | longTasks.maxMs |
| -------------------------------------- | --------- | ------------: | -----------: | -----------: | ---------------: | ----------------: |
| warm-2026-08-02T15-51-06-268Z.json     | populate  | 892           | 23.93        | 11,184,709   | 1                 | 56                |
| warm-2026-08-02T15-51-13-573Z.json     | measured  | 628.6         | 24.82        | 79,355       | 2                 | 55                |
| warm-2026-08-02T15-51-20-298Z.json     | measured  | 571.6         | 24.47        | 15,788       | 2                 | 61                |
| warm-2026-08-02T15-51-26-353Z.json     | measured  | 552.2         | 24.52        | 15,788       | 2                 | 55                |

`panP95FrameMs`, `moveSettleP95Ms`, `geoCache` are `null` in all 4 (not
applicable to this scenario / cache doesn't exist).

</details>

<details>
<summary>Pan (3 runs, browser)</summary>

| timestamp (result file)              | initialLoadMs | panP95FrameMs | moveSettleP95Ms | usedJSHeapMB | networkBytes | longTasks.count | longTasks.maxMs |
| -------------------------------------- | ------------: | -------------: | ----------------: | -----------: | -----------: | ---------------: | ----------------: |
| pan-2026-08-02T15-51-50-280Z.json      | 931.8         | 1960.9         | 17,169.2           | 1058.79      | 66,753,204   | 15                | 5256              |
| pan-2026-08-02T15-52-16-319Z.json      | 907.6         | 787.6          | null               | 1058.71      | 67,035,730   | 17                | 4939              |
| pan-2026-08-02T15-52-44-498Z.json      | 1015.4        | 604.6          | null               | 560.87       | 66,752,859   | 16                | 2597              |

`geoCache` is `null` in all 3 (cache doesn't exist yet).

</details>

<details>
<summary>Server-side <code>bench.py measure</code>, raw console output (single run)</summary>

```
Bench 10,000  (10,000 features)
  tiles cold : p50   18.5 ms   p95   21.8 ms
  tiles warm : p50   10.2 ms   p95   14.5 ms
  features   : p50   91.1 ms   p95  200.2 ms
  attributes : p50   18.6 ms   p95   22.5 ms   total 10,000 (exact)

Bench 100,000  (100,000 features)
  tiles cold : p50   52.7 ms   p95   70.7 ms
  tiles warm : p50   12.8 ms   p95   21.8 ms
  features   : p50  112.2 ms   p95  224.3 ms
  attributes : p50   15.4 ms   p95   16.7 ms   total 100,000 (estimated)

Bench 1,000,000  (1,000,000 features)
  tiles cold : p50  306.2 ms   p95  331.9 ms
  tiles warm : p50   27.4 ms   p95   59.2 ms
  features   : p50  114.2 ms   p95  196.5 ms
  attributes : p50   18.0 ms   p95   24.2 ms   total 1,000,000 (estimated)
```

</details>
