import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, apiFetch } from './client'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const response = new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
}

afterEach(() => vi.restoreAllMocks())

describe('apiFetch', () => {
  it('returns the parsed body on success', async () => {
    mockFetch(200, { id: 'abc', name: 'Roads' })
    await expect(apiFetch<{ name: string }>('/layers/abc')).resolves.toEqual({
      id: 'abc',
      name: 'Roads',
    })
  })

  it('prefixes the API base path', async () => {
    const spy = mockFetch(200, {})
    await apiFetch('/projects')
    expect(spy.mock.calls[0]?.[0]).toBe('/api/v1/projects')
  })

  it('returns undefined for 204 responses', async () => {
    mockFetch(204, null)
    await expect(apiFetch('/layers/abc')).resolves.toBeUndefined()
  })

  it('throws an ApiError carrying the envelope code and details', async () => {
    mockFetch(404, {
      error: { code: 'not_found', message: 'Layer 7 not found', details: { layerId: 7 } },
    })
    const error = await apiFetch('/layers/7').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).code).toBe('not_found')
    expect((error as ApiError).message).toBe('Layer 7 not found')
    expect((error as ApiError).details).toEqual({ layerId: 7 })
  })

  it('falls back to a generic message when the body is not an envelope', async () => {
    const response = new Response('<html>502</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    const error = (await apiFetch('/layers').catch((caught: unknown) => caught)) as ApiError
    expect(error.status).toBe(502)
    expect(error.code).toBe('http_error')
    expect(error.message).toContain('502')
  })

  it('sends JSON bodies with the right content type', async () => {
    const spy = mockFetch(200, {})
    await apiFetch('/projects', { method: 'POST', json: { name: 'P' } })
    const init = spy.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"name":"P"}')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('does not set a content type for FormData bodies', async () => {
    const spy = mockFetch(200, {})
    const form = new FormData()
    form.append('file', new Blob(['x']), 'a.geojson')
    await apiFetch('/import', { method: 'POST', body: form })
    const init = spy.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('content-type')).toBeNull()
  })
})
