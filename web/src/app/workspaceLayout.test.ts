import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_LAYOUT,
  clampFloat,
  deletePreset,
  listPresets,
  loadLayout,
  savePreset,
  saveLayout,
} from './workspaceLayout'

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

  it('round-trips R9 docking state and keeps pre-R9 entries loadable', () => {
    // A layout saved before R9 has none of the new keys.
    localStorage.setItem(
      'graticule:layout:p1',
      JSON.stringify({ sidebarOpen: false, inspectorOpen: true, tableOpen: false }),
    )
    expect(loadLayout('p1')).toEqual({ ...DEFAULT_LAYOUT, sidebarOpen: false })

    saveLayout('p1', {
      ...DEFAULT_LAYOUT,
      sidebarSide: 'right',
      inspectorFloat: { x: 120, y: 80 },
    })
    expect(loadLayout('p1')).toMatchObject({
      sidebarSide: 'right',
      inspectorFloat: { x: 120, y: 80 },
    })
  })

  it('survives corrupted storage', () => {
    localStorage.setItem('graticule:layout:p1', '{not json')
    expect(loadLayout('p1')).toEqual(DEFAULT_LAYOUT)
  })
})

describe('clampFloat', () => {
  it('keeps the header reachable inside the stage', () => {
    const stage = { width: 1000, height: 600 }
    expect(clampFloat({ x: 2000, y: 2000 }, stage, 300)).toEqual({ x: 952, y: 552 })
    expect(clampFloat({ x: -900, y: -50 }, stage, 300)).toEqual({ x: -252, y: 0 })
  })
})

describe('layout presets', () => {
  const layoutA = { ...DEFAULT_LAYOUT, sidebarOpen: false }
  const layoutB = { ...DEFAULT_LAYOUT, inspectorFloat: { x: 10, y: 20 } }

  it('creates, lists (project before global, alphabetical), and deletes', () => {
    savePreset('p1', 'zeta', 'project', layoutA)
    savePreset('p1', 'alpha', 'project', layoutB)
    savePreset('p1', 'shared', 'global', layoutA)

    const names = listPresets('p1').map((preset) => `${preset.name}:${preset.scope}`)
    expect(names).toEqual(['alpha:project', 'zeta:project', 'shared:global'])

    const zeta = listPresets('p1').find((preset) => preset.name === 'zeta')!
    deletePreset('p1', zeta)
    expect(listPresets('p1').map((preset) => preset.name)).toEqual(['alpha', 'shared'])
  })

  it('keeps project presets private and global presets shared', () => {
    savePreset('p1', 'mine', 'project', layoutA)
    savePreset('p1', 'everywhere', 'global', layoutB)

    expect(listPresets('p2').map((preset) => preset.name)).toEqual(['everywhere'])
    expect(listPresets('p2')[0]!.layout).toMatchObject({ inspectorFloat: { x: 10, y: 20 } })
  })

  it('overwrites a preset saved under the same name and scope', () => {
    const first = savePreset('p1', 'review', 'project', layoutA)
    const second = savePreset('p1', 'review', 'project', layoutB)

    const presets = listPresets('p1')
    expect(presets).toHaveLength(1)
    expect(presets[0]!.id).toBe(first.id)
    expect(second.id).toBe(first.id)
    expect(presets[0]!.layout).toMatchObject({ inspectorFloat: { x: 10, y: 20 } })
  })

  it('ignores corrupted preset storage', () => {
    localStorage.setItem('graticule:layout-presets:p1', 'not an array at all')
    localStorage.setItem('graticule:layout-presets:global', '[{"bogus": true}]')
    expect(listPresets('p1')).toEqual([])
  })
})
