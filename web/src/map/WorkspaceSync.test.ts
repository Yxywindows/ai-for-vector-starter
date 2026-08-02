import { describe, expect, it } from 'vitest'

import { parseSelParam, parseViewParam } from './WorkspaceSync'

describe('parseViewParam', () => {
  it('parses z/lon/lat', () => {
    expect(parseViewParam('4.50/105.20000/35.10000')).toEqual({
      center: [105.2, 35.1],
      zoom: 4.5,
    })
  })

  it('rejects malformed or out-of-range values', () => {
    expect(parseViewParam(null)).toBeNull()
    expect(parseViewParam('4.5/105.2')).toBeNull()
    expect(parseViewParam('nope/1/2')).toBeNull()
    expect(parseViewParam('4/999/0')).toBeNull()
  })
})

describe('parseSelParam', () => {
  it('parses a layer with feature ids', () => {
    expect(parseSelParam('l1:7,9')).toEqual({ layerId: 'l1', featureIds: ['7', '9'] })
  })

  it('parses a bare layer selection', () => {
    expect(parseSelParam('l1')).toEqual({ layerId: 'l1', featureIds: [] })
  })

  it('rejects empty input', () => {
    expect(parseSelParam(null)).toBeNull()
    expect(parseSelParam('')).toBeNull()
  })
})
