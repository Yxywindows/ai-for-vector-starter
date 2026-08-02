#!/usr/bin/env node
/**
 * Playwright benchmark harness for the map workspace.
 *
 * Drives a real Chromium against the running dev stack (Vite on 1317,
 * proxying /api to the FastAPI backend on 1316) and measures the hot path
 * a user actually feels: navigate to /projects/:projectId/map, wait for the
 * first OL render, and (for `pan`) run a scripted pan. This is the
 * measurement foundation for the loading-performance session — later tasks
 * are judged against a baseline captured with this tool, so it must not be
 * fudged or simplified away from what it claims to measure.
 *
 * Usage (run from web/, with the backend + `npm run dev` already running
 * and the Benchmarks project seeded — see bench/README.md):
 *
 *   node bench/bench.mjs --scenario cold|warm|pan [--project "Benchmarks"] [--url http://localhost:1317]
 *
 * Writes bench/results/<scenario>-<runstamp>.json and prints a summary
 * table. See bench/README.md for what each scenario/metric means and why
 * `warm` needs two runs.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

/** 95th percentile of a sample array, or null if there's nothing to rank. */
function p95(samples) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

function round(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100
}

async function resolveProjectId(baseUrl, projectName) {
  const res = await fetch(`${baseUrl}/api/v1/projects`)
  if (!res.ok) {
    throw new Error(`GET /api/v1/projects failed: ${res.status} ${res.statusText}`)
  }
  const projects = await res.json()
  const project = projects.find((candidate) => candidate.name === projectName)
  if (!project) {
    throw new Error(
      `No project named "${projectName}" found via GET /api/v1/projects. Seed it with:\n` +
        `  cd backend && ./.venv/Scripts/python.exe scripts/bench.py seed`,
    )
  }
  return project.id
}

/**
 * Scripted pan: 5 animated moves between two anchors ~50km apart in the
 * view's projected (EPSG:3857) coordinates. Runs entirely inside the page
 * because it needs the live OL `View` — the harness has no OL instance of
 * its own, so it drives the app's map through the dev-only `window.__olMap`
 * hook (see MapCanvas.tsx).
 *
 * Records two things:
 *  - frameDeltas: rAF-to-rAF gaps across the whole sequence -> panP95FrameMs
 *  - moveSettleTimes: moveend -> next rendercomplete, per move -> moveSettleP95Ms
 *
 * OL suppresses 'rendercomplete' entirely while the view's ANIMATING hint
 * is set, and un-suppresses it in the SAME render-frame callback that also
 * dispatches 'moveend' once the animation finishes — so a `.once` listener
 * registered only *after* awaiting 'moveend' can miss a 'rendercomplete'
 * that already fired synchronously in that same tick (a real hang observed
 * during development). To avoid the race, both listeners are attached
 * up front as persistent collectors and correlated by timestamp afterward,
 * and move completion uses `view.animate()`'s own callback rather than
 * racing 'moveend' (which OL also fires from that same callback).
 *
 * Observed against the seeded 1M-point bench layer: panning into a fresh
 * viewport can start a feature/tile load whose 'loadend' never arrives
 * within the poll budget below, so the map's "not loading" state — and
 * therefore 'rendercomplete' — never recurs after the first move. When that
 * happens `moveSettleTimes` legitimately comes back empty and
 * `moveSettleP95Ms` is reported as `null`; that's a real characteristic of
 * the current (pre-optimization) loading path under heavy layers, not a bug
 * in this harness.
 */
async function runPanScript(page) {
  return page.evaluate(async () => {
    const map = window.__olMap
    if (!map) {
      throw new Error(
        'window.__olMap is missing — the MapCanvas dev hook (import.meta.env.DEV) did not run. ' +
          'Is the app running via `npm run dev` (not a production build)?',
      )
    }
    const view = map.getView()
    const start = view.getCenter()
    const end = [start[0] + 50_000, start[1] + 50_000]

    const frameDeltas = []
    let last = performance.now()
    let tracking = true
    const trackFrame = () => {
      if (!tracking) return
      const now = performance.now()
      frameDeltas.push(now - last)
      last = now
      requestAnimationFrame(trackFrame)
    }
    requestAnimationFrame(trackFrame)

    const renderCompleteTimes = []
    map.on('rendercomplete', () => renderCompleteTimes.push(performance.now()))

    const moveEndTimes = []
    for (let i = 0; i < 5; i++) {
      const target = i % 2 === 0 ? end : start
      const moveEndAt = await new Promise((resolve) => {
        view.animate({ center: target, duration: 800 }, () => resolve(performance.now()))
      })
      moveEndTimes.push(moveEndAt)
    }
    tracking = false

    // Give a rendercomplete triggered by the final move time to land — under
    // a heavy layer (e.g. the 1M-point bench layer) the main thread can stay
    // busy well past the animation itself, so poll with a bounded budget
    // instead of a fixed short sleep (and instead of waiting unboundedly,
    // which is exactly the hang this function used to have).
    const lastMoveEndAt = moveEndTimes[moveEndTimes.length - 1]
    const pollDeadline = performance.now() + 5_000
    while (
      !renderCompleteTimes.some((t) => t >= lastMoveEndAt) &&
      performance.now() < pollDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const moveSettleTimes = moveEndTimes
      .map((moveEndAt) => {
        const settledAt = renderCompleteTimes.find((t) => t >= moveEndAt)
        return settledAt === undefined ? null : settledAt - moveEndAt
      })
      .filter((delta) => delta !== null)

    return { frameDeltas, moveSettleTimes }
  })
}

async function main() {
  const scenario = arg('--scenario', 'cold')
  if (!['cold', 'warm', 'pan'].includes(scenario)) {
    throw new Error(`--scenario must be cold|warm|pan, got "${scenario}"`)
  }
  const projectName = arg('--project', 'Benchmarks')
  const baseUrl = arg('--url', 'http://localhost:1317')

  const projectId = await resolveProjectId(baseUrl, projectName)

  // `warm` reuses one profile dir across runs so IndexedDB + HTTP caches
  // persist between invocations; `cold` and `pan` each start from a fresh
  // dir (pan does a normal cold-style load before its scripted pan).
  const profileDir = path.join(
    'bench',
    '.profiles',
    scenario === 'warm' ? 'warm' : `${scenario}-${Date.now()}`,
  )
  await mkdir(profileDir, { recursive: true })

  const ctx = await chromium.launchPersistentContext(profileDir, {
    args: ['--enable-precise-memory-info'],
    viewport: { width: 1440, height: 900 },
  })

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage())

    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    let networkBytes = 0
    cdp.on('Network.loadingFinished', (event) => {
      networkBytes += event.encodedDataLength
    })

    await page.addInitScript(() => {
      window.__bench = { longTasks: [], frames: [] }
      new PerformanceObserver((list) => {
        window.__bench.longTasks.push(...list.getEntries().map((entry) => entry.duration))
      }).observe({ type: 'longtask', buffered: true })
    })

    await page.goto(`${baseUrl}/projects/${projectId}/map`)
    await page.waitForFunction(
      () => performance.getEntriesByName('graticule:first-render').length > 0,
      { timeout: 120_000 },
    )

    // initialLoadMs: navigation start -> first OL rendercomplete, taken from
    // the browser's own high-res clocks (not Node wall-clock around goto()).
    const initialLoadMs = await page.evaluate(() => {
      const [nav] = performance.getEntriesByType('navigation')
      const [mark] = performance.getEntriesByName('graticule:first-render')
      return mark.startTime - (nav ? nav.startTime : 0)
    })

    let panP95FrameMs = null
    let moveSettleP95Ms = null
    if (scenario === 'pan') {
      const { frameDeltas, moveSettleTimes } = await runPanScript(page)
      panP95FrameMs = round(p95(frameDeltas))
      moveSettleP95Ms = round(p95(moveSettleTimes))
    }

    const usedJSHeapMB = await page.evaluate(() =>
      performance.memory ? performance.memory.usedJSHeapSize / (1024 * 1024) : null,
    )

    const bench = await page.evaluate(() => window.__bench ?? { longTasks: [] })
    const longTaskDurations = bench.longTasks ?? []
    const longTasks = {
      count: longTaskDurations.length,
      maxMs: longTaskDurations.length ? round(Math.max(...longTaskDurations)) : 0,
    }

    // window.__geoCache doesn't exist yet (a later task adds it) — read
    // defensively and report null until then.
    const geoCache = await page.evaluate(() => {
      try {
        const cache = window.__geoCache
        return cache && typeof cache.metrics === 'function' ? cache.metrics() : null
      } catch {
        return null
      }
    })

    const results = {
      scenario,
      url: baseUrl,
      projectId,
      timestamp: new Date().toISOString(),
      initialLoadMs: round(initialLoadMs),
      panP95FrameMs,
      moveSettleP95Ms,
      usedJSHeapMB: round(usedJSHeapMB),
      networkBytes,
      longTasks,
      geoCache,
    }

    await mkdir(path.join('bench', 'results'), { recursive: true })
    const runstamp = results.timestamp.replace(/[:.]/g, '-')
    const resultsPath = path.join('bench', 'results', `${scenario}-${runstamp}.json`)
    await writeFile(resultsPath, JSON.stringify(results, null, 2))

    console.log(`\nbench: ${scenario}  project="${projectName}" (${projectId})  url=${baseUrl}`)
    console.table({
      initialLoadMs: results.initialLoadMs,
      panP95FrameMs: results.panP95FrameMs,
      moveSettleP95Ms: results.moveSettleP95Ms,
      usedJSHeapMB: results.usedJSHeapMB,
      networkBytes: results.networkBytes,
      'longTasks.count': longTasks.count,
      'longTasks.maxMs': longTasks.maxMs,
    })
    console.log(
      `geoCache: ${geoCache ? JSON.stringify(geoCache) : 'null (window.__geoCache not implemented yet)'}`,
    )
    console.log(`wrote ${resultsPath}\n`)
  } finally {
    await ctx.close()
  }
}

main().catch((error) => {
  console.error(`bench failed: ${error.stack ?? error.message}`)
  process.exitCode = 1
})
