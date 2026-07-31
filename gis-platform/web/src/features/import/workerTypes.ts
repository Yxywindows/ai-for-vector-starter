import type { ParseResult } from './parseGeoJson'

export interface ParseRequest {
  /**
   * Correlates a response with the `parse()` call that sent the request.
   * Every pending call listens on the shared worker, so responses must be
   * addressed or a fast reply could settle the wrong caller's promise.
   */
  requestId: number
  text: string
}

export type ParseResponse =
  | { requestId: number; ok: true; result: ParseResult }
  | { requestId: number; ok: false; code: string; message: string }
