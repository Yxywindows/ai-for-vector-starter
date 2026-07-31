/**
 * Run parsing off the main thread, with an inline fallback.
 *
 * A worker is an optimisation, not a requirement: if one cannot be built
 * (no worker support, a restrictive CSP, a test environment), parsing still
 * happens -- just on the main thread. Behaviour is identical either way,
 * because both paths call the same `parseGeoJson`.
 */

import { useCallback, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { ParseError, type ParseResult, parseGeoJson } from './parseGeoJson'
import type { ParseRequest, ParseResponse } from './workerTypes'

function createWorker(): Worker | null {
  try {
    return new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

export function useParseWorker() {
  const workerRef = useRef<Worker | null | undefined>(undefined)
  const [usedFallback, setUsedFallback] = useState(false)

  const parse = useCallback((text: string): Promise<ParseResult> => {
    if (workerRef.current === undefined) workerRef.current = createWorker()
    const worker = workerRef.current

    if (!worker) {
      // Flushed synchronously so `usedFallback` is already visible on
      // `result.current` by the time the caller's `await` resolves --
      // React's default scheduling can otherwise lag behind a microtask,
      // leaving the flag looking stale even though it was "set".
      flushSync(() => setUsedFallback(true))
      // Deferred to a microtask so both paths reject asynchronously, and a
      // synchronous throw here can never escape into React's render phase.
      return Promise.resolve().then(() => parseGeoJson(text))
    }

    return new Promise<ParseResult>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
      }

      const onMessage = (event: MessageEvent<ParseResponse>) => {
        cleanup()
        const data = event.data
        if (data.ok) resolve(data.result)
        else reject(new ParseError(data.code, data.message))
      }

      const onError = (event: ErrorEvent) => {
        cleanup()
        // A worker that dies mid-parse must not hang the preview: fall back.
        workerRef.current = null
        flushSync(() => setUsedFallback(true))
        try {
          resolve(parseGeoJson(text))
        } catch (error) {
          reject(error instanceof ParseError ? error : new ParseError('parse_failed', event.message))
        }
      }

      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      const request: ParseRequest = { text }
      worker.postMessage(request)
    })
  }, [])

  return { parse, usedFallback }
}
