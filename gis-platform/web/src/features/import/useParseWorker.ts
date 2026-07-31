/**
 * Run parsing off the main thread, with an inline fallback.
 *
 * A worker is an optimisation, not a requirement: if one cannot be built
 * (no worker support, a restrictive CSP, a test environment), parsing still
 * happens -- just on the main thread. Behaviour is identical either way,
 * because both paths call the same `parseGeoJson`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { ParseError, type ParseResult, parseGeoJson } from './parseGeoJson'
import type { ParseRequest, ParseResponse } from './workerTypes'

/**
 * How long a parse may wait with no worker response before the hook assumes
 * the worker is dead and re-parses inline. A worker killed by the browser
 * (e.g. under memory pressure) fires no 'error' event at all, so without a
 * watchdog the promise would never settle. Far above any legitimate parse
 * of a file within the import size limit.
 */
const WORKER_TIMEOUT_MS = 30_000

function createWorker(): Worker | null {
  try {
    return new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

export function useParseWorker() {
  const workerRef = useRef<Worker | null | undefined>(undefined)
  const nextRequestId = useRef(0)
  const [usedFallback, setUsedFallback] = useState(false)

  useEffect(
    () => () => {
      workerRef.current?.terminate()
      workerRef.current = undefined
    },
    [],
  )

  const parse = useCallback((text: string): Promise<ParseResult> => {
    if (workerRef.current === undefined) workerRef.current = createWorker()
    const worker = workerRef.current

    if (!worker) {
      // Flushed synchronously so `usedFallback` is already visible on
      // `result.current` by the time the caller's `await` resolves --
      // React's default scheduling can otherwise lag behind a microtask,
      // leaving the flag looking stale even though it was "set". Callers
      // must invoke parse() from event handlers: inside render or a
      // commit-phase lifecycle, flushSync degrades to async scheduling
      // and the guarantee is lost.
      flushSync(() => setUsedFallback(true))
      // Deferred to a microtask so both paths reject asynchronously, and a
      // synchronous throw here can never escape into React's render phase.
      return Promise.resolve().then(() => parseGeoJson(text))
    }

    const requestId = ++nextRequestId.current

    return new Promise<ParseResult>((resolve, reject) => {
      // `watchdog` is declared below, after the handlers that reference it;
      // cleanup() only ever runs from an event or the timer, both strictly
      // after the const initialises.
      const cleanup = () => {
        clearTimeout(watchdog)
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        worker.removeEventListener('messageerror', onUndeliverable)
      }

      // A worker that dies mid-parse -- an uncaught error, an undeliverable
      // response, or silent termination (which fires no event; the watchdog
      // covers it) -- must not hang the preview: parse inline instead.
      const fallBack = () => {
        cleanup()
        worker.terminate()
        workerRef.current = null
        flushSync(() => setUsedFallback(true))
        try {
          resolve(parseGeoJson(text))
        } catch (error) {
          reject(
            error instanceof ParseError
              ? error
              : new ParseError('parse_failed', (error as Error).message),
          )
        }
      }

      const onMessage = (event: MessageEvent<ParseResponse>) => {
        // Every pending parse hears every message on the shared worker;
        // only take the response addressed to this call.
        if (event.data.requestId !== requestId) return
        cleanup()
        const data = event.data
        if (data.ok) resolve(data.result)
        else reject(new ParseError(data.code, data.message))
      }

      const onError = () => fallBack()
      const onUndeliverable = () => fallBack()

      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.addEventListener('messageerror', onUndeliverable)
      const watchdog = setTimeout(fallBack, WORKER_TIMEOUT_MS)
      const request: ParseRequest = { requestId, text }
      worker.postMessage(request)
    })
  }, [])

  return { parse, usedFallback }
}
