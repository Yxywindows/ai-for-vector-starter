import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as featuresApi from '../api/features'
import type { FeatureCollection } from '../api/types'
import { createBboxLoader, createFullLoader, simplifyToleranceFor } from './featureLoader'

vi.mock('../api/features', () => ({ getFeatures: vi.fn() }))

const EMPTY: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
  returned: 0,
  limit: 2000,
  truncated: false,
}

const sourceStub = () => ({ addFeatures: vi.fn() })

const callLoader = (
  loader: ReturnType<typeof createBboxLoader>,
  source: ReturnType<typeof sourceStub>,
  extent: number[] = [0, 0, 1, 1],
  resolution = 10,
) =>
  loader.call(
    source as never,
    extent,
    resolution,
    'EPSG:3857' as never,
    undefined as never,
    undefined as never,
  )

beforeEach(() => {
  vi.mocked(featuresApi.getFeatures).mockReset()
})

describe('simplifyToleranceFor', () => {
  it('skips simplification at city zoom, where true vertices matter', () => {
    expect(simplifyToleranceFor(1.5)).toBeUndefined()
  })

  it('scales the tolerance with the view resolution', () => {
    expect(simplifyToleranceFor(100)).toBeCloseTo((100 * 1.5) / 111_320)
  })
})

describe('createBboxLoader', () => {
  it('aborts the superseded request when a new extent loads', () => {
    const signals: AbortSignal[] = []
    vi.mocked(featuresApi.getFeatures).mockImplementation((_id, _bbox, options) => {
      signals.push(options!.signal!)
      return new Promise<FeatureCollection>(() => {}) // stays in flight
    })

    const loader = createBboxLoader('l1', {})
    const source = sourceStub()
    callLoader(loader, source, [0, 0, 1, 1])
    callLoader(loader, source, [1, 1, 2, 2])

    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
  })

  it('requests zoom-scaled simplification and reports truncation', async () => {
    vi.mocked(featuresApi.getFeatures).mockResolvedValue({ ...EMPTY, truncated: true })
    const onTruncated = vi.fn()

    const loader = createBboxLoader('l1', { onTruncated })
    callLoader(loader, sourceStub(), [0, 0, 1, 1], 500)

    await vi.waitFor(() => expect(onTruncated).toHaveBeenCalledWith('l1', true))
    const options = vi.mocked(featuresApi.getFeatures).mock.calls[0]![2]!
    expect(options.simplify).toBeCloseTo((500 * 1.5) / 111_320)
  })
})

describe('createFullLoader', () => {
  it('fetches the whole layer once with the small-tier cap and no simplification', async () => {
    vi.mocked(featuresApi.getFeatures).mockResolvedValue(EMPTY)
    const source = sourceStub()

    const loader = createFullLoader('l1', 2000, {})
    callLoader(loader, source)

    await vi.waitFor(() => expect(source.addFeatures).toHaveBeenCalled())
    const [, bbox, options] = vi.mocked(featuresApi.getFeatures).mock.calls[0]!
    expect(bbox).toEqual([-180, -90, 180, 90])
    expect(options!.limit).toBe(2000)
    expect(options!.simplify).toBeUndefined()
  })
})
