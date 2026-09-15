> 历史设计/计划记录：保留原始上下文，不作为当前功能清单或执行指令。当前实现请从 [文档目录](../README.md) 阅读；下文的待办和完成状态仅代表当时记录。

# Session Handoff

> Living document. Each session ends by rewriting this file: completed work, key
> decisions, benchmark results, remaining risks, exact next-session task.
> Sessions start from ONLY the repository state + this file + the plan:
> `docs/superpowers/plans/2026-08-02-four-session-gis-improvement.md`.

**Last updated:** 2026-08-02 (planning session, no implementation yet)

## Completed work

- Repository inspected end-to-end (architecture, data pipeline, map engine, storage, tests) and the four-session implementation plan written: `docs/superpowers/plans/2026-08-02-four-session-gis-improvement.md`. Read its "Current state" and "Decision log" sections before anything else — they replace re-exploration.
- Committed the previously dangling working-tree fix (non-JSON 2xx handling in `apiFetch`, router error boundary, Tasks-page error state — 7 files, tests included). Web quality gate was run green before committing.

## Key decisions (planning)

- Client cache hierarchy is hand-rolled (memory LRU → IndexedDB → conditional HTTP with `If-None-Match`), keyed by `layer.updatedAt` — no service worker, no new runtime deps. Full rationale in the plan's decision log.
- Real data: Natural Earth + Geofabrik Monaco + Geofabrik Berlin (≈220 MB); Hangzhou via Overpass over a fixed study extent `120.115–120.205 E, 30.215–30.285 N`. No tippecanoe/PMTiles (Windows dev).
- Project deletion becomes reference-counted artifact cleanup + an idempotent orphan sweeper; DB-truth-first with best-effort disk cleanup.

## Benchmark results

None yet. Session 1 Task 1.2 records the baseline BEFORE any cache work
(`backend/scripts/bench.py seed && … measure` + the new Playwright harness) into
`docs/benchmarks.md`. Do not start Task 1.3+ until the baseline is committed.

## Remaining risks

- `LayerRead` may not expose `updatedAt` on the wire — verify in Task 1.6 (one-line schema addition if missing).
- Backend test suite needs PostGIS up (`docker compose up -d postgres`) and the `gis_platform_test` DB (README step 2); harness/e2e need backend (1316) + web dev (1317) running.
- ~20 orphaned `backend/var/data/tmp/tasks/*` dirs and orphaned `gis_data` tables exist today; Session 2's sweeper removes them — don't clean them manually.
- ~30 untracked screenshots at repo root are ignored (not deleted) by Session 1 Task 1.0.

## Next session task

**Session 1 — Geospatial Loading Performance.** Execute plan Tasks 1.0 → 1.12 in
order (housekeeping → bench harness → baseline → features ETag → IDB wrapper →
geoCache → tile wiring → feature wiring/worker → prefetch → metadata snapshot →
clustering → metrics panel → final benchmarks). Acceptance criteria and exact
test commands are in the plan's Session 1 header. End by rewriting this file.
