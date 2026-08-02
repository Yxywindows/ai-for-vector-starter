import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_LAYOUT, loadLayout, saveLayout } from './workspaceLayout'

beforeEach(() => localStorage.clear())

describe('workspace layout persistence', () => {
  it('returns defaults for an unknown project', () => {
    expect(loadLayout('p1')).toEqual(DEFAULT_LAYOUT)
  })

  it('round-trips a saved layout per project', () => {
    saveLayout('p1', { ...DEFAULT_LAYOUT, tableOpen: true, sidebarWidth: 320 })
    expect(loadLayout('p1')).toMatchObject({ tableOpen: true, sidebarWidth: 320 })
    expect(loadLayout('p2')).toEqual(DEFAULT_LAYOUT)
  })

  it('survives corrupted storage', () => {
    localStorage.setItem('graticule:layout:p1', '{not json')
    expect(loadLayout('p1')).toEqual(DEFAULT_LAYOUT)
  })
})
