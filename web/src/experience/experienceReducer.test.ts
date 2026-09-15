import { describe, expect, it } from 'vitest'
import { experienceReducer as reduce, initialExperienceState } from './experienceReducer'
import { FEATURES, featureForPath, isWorkspacePath } from './featureRegistry'

const home = () => initialExperienceState({ key: 'home', pathname: '/' })

describe('experience navigation contract', () => {
  it('maps six distinct faces and preserves project/data descendants', () => {
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(6)
    expect(new Set(FEATURES.map((f) => f.normal.join(','))).size).toBe(6)
    expect(featureForPath('/projects/p1/map')?.id).toBe('projects')
    expect(featureForPath('/data/l1/schema')?.id).toBe('data')
    expect(featureForPath('/database')).toBeNull()
    expect(isWorkspacePath('/projects/p1/map/')).toBe(true)
    expect(isWorkspacePath('/projects/p1/map/other')).toBe(false)
  })
  it('starts deep links active without depending on an earlier scene', () => {
    expect(initialExperienceState({ key: 'direct', pathname: '/analysis' })).toMatchObject({
      phase: 'active',
      selectedFeature: 'analysis',
    })
  })
  it('rejects a stale completion when the user changes the intended feature', () => {
    const first = reduce(home(), { type: 'SELECT', feature: 'projects', reduced: false })
    const latest = reduce(first, { type: 'SELECT', feature: 'analysis', reduced: false })
    expect(reduce(latest, { type: 'FINISH', transitionId: first.transitionId })).toBe(latest)
    expect(reduce(latest, { type: 'FINISH', transitionId: latest.transitionId })).toMatchObject({
      phase: 'preview',
      selectedFeature: 'analysis',
    })
  })
  it('cancels expansion on a new choice or Escape', () => {
    const preview = reduce(home(), { type: 'SELECT', feature: 'projects', reduced: true })
    const expanding = reduce(preview, { type: 'EXPAND', reduced: false })
    const next = reduce(expanding, { type: 'SELECT', feature: 'data', reduced: false })
    expect(reduce(next, { type: 'FINISH', transitionId: expanding.transitionId })).toBe(next)
    const cancelled = reduce(expanding, { type: 'CANCEL' })
    expect(
      reduce(cancelled, { type: 'FINISH', transitionId: expanding.transitionId }),
    ).toMatchObject({ phase: 'idle', selectedFeature: null })
  })
  it('invalidates pending navigation on browser history changes', () => {
    const preview = reduce(home(), { type: 'SELECT', feature: 'projects', reduced: true })
    const pending = reduce(preview, { type: 'EXPAND', reduced: false })
    const direct = reduce(pending, {
      type: 'ROUTE_CHANGED',
      route: { key: 'history', pathname: '/exports' },
    })
    expect(reduce(direct, { type: 'FINISH', transitionId: pending.transitionId })).toMatchObject({
      phase: 'active',
      selectedFeature: 'exports',
    })
  })
  it('retains the selected navigation focus when returning home', () => {
    const active = initialExperienceState({ key: 'page', pathname: '/data/item/schema' })
    const returning = reduce(active, { type: 'RETURN' })
    const arrived = reduce(returning, {
      type: 'ROUTE_CHANGED',
      route: { key: 'returned', pathname: '/' },
    })
    expect(arrived).toMatchObject({
      phase: 'returning',
      selectedFeature: null,
      returnFocus: 'data',
    })
    expect(reduce(arrived, { type: 'FINISH', transitionId: arrived.transitionId }).phase).toBe(
      'idle',
    )
  })
  it('ignores scene selection and cancellation while a real page owns the URL', () => {
    const active = initialExperienceState({ key: 'active', pathname: '/projects/p1/map' })
    expect(reduce(active, { type: 'SELECT', feature: 'data', reduced: true })).toBe(active)
    expect(reduce(active, { type: 'CANCEL' })).toBe(active)
  })
})
