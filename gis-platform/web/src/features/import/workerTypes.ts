import type { ParseResult } from './parseGeoJson'

export interface ParseRequest {
  text: string
}

export type ParseResponse =
  | { ok: true; result: ParseResult }
  | { ok: false; code: string; message: string }
