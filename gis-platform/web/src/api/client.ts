export const API_BASE = '/api/v1'

export interface ApiErrorEnvelope {
  error: { code: string; message: string; details: unknown }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  body?: BodyInit | null
  /** Convenience: serialised to JSON with the correct content type. */
  json?: unknown
}

function isEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = (value as { error?: unknown }).error
  return typeof candidate === 'object' && candidate !== null && 'code' in candidate
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const finalHeaders = new Headers(headers)
  let body = rest.body

  if (json !== undefined) {
    body = JSON.stringify(json)
    finalHeaders.set('content-type', 'application/json')
  }

  const response = await fetch(`${API_BASE}${path}`, { ...rest, body, headers: finalHeaders })

  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''
  const payload: unknown = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    if (isEnvelope(payload)) {
      throw new ApiError(
        response.status,
        payload.error.code,
        payload.error.message,
        payload.error.details,
      )
    }
    throw new ApiError(
      response.status,
      'http_error',
      `Request failed with status ${response.status}`,
      payload,
    )
  }

  return payload as T
}
