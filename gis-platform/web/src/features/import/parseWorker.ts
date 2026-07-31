/// <reference lib="webworker" />
/**
 * Transport only. All parsing logic lives in `parseGeoJson.ts` so it stays
 * testable without worker plumbing, and so the main-thread fallback in
 * `useParseWorker.ts` runs byte-identical code.
 */

import { ParseError, parseGeoJson } from './parseGeoJson'
import type { ParseRequest, ParseResponse } from './workerTypes'

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { requestId, text } = event.data
  try {
    const result = parseGeoJson(text)
    const response: ParseResponse = { requestId, ok: true, result }
    self.postMessage(response)
  } catch (error) {
    const response: ParseResponse =
      error instanceof ParseError
        ? { requestId, ok: false, code: error.code, message: error.message }
        : { requestId, ok: false, code: 'parse_failed', message: (error as Error).message }
    self.postMessage(response)
  }
}
