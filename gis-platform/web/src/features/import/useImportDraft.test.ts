import { StrictMode } from 'react'

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { parseGeoJson } from './parseGeoJson'
import { draftFromParse, useImportDraft } from './useImportDraft'

const DOCUMENT = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.4, 39.9] },
      properties: { name: 'Beijing', pop: 21540000 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [91.1, 29.6] },
      properties: { name: 'Lhasa', pop: 560000 },
    },
  ],
})

const start = () =>
  renderHook(() => useImportDraft(draftFromParse(parseGeoJson(DOCUMENT), 'cities.geojson', 1234)))

describe('useImportDraft', () => {
  it('starts clean with nothing to undo', () => {
    const { result } = start()
    expect(result.current.isDirty).toBe(false)
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    expect(result.current.draft!.features).toHaveLength(2)
  })

  it('edits a cell and becomes dirty', () => {
    const { result } = start()
    act(() => result.current.setCellValue('0', 'name', 'Beijing Municipality'))
    expect(result.current.draft!.features[0]!.properties.name).toBe('Beijing Municipality')
    expect(result.current.isDirty).toBe(true)
  })

  it('undo restores the previous value and redo reapplies it', () => {
    const { result } = start()
    act(() => result.current.setCellValue('0', 'name', 'Changed'))
    act(() => result.current.undo())
    expect(result.current.draft!.features[0]!.properties.name).toBe('Beijing')
    expect(result.current.isDirty).toBe(false)

    act(() => result.current.redo())
    expect(result.current.draft!.features[0]!.properties.name).toBe('Changed')
    expect(result.current.isDirty).toBe(true)
  })

  it('survives StrictMode double-invocation of state updaters', () => {
    // React's StrictMode (which the real app mounts under, in main.tsx)
    // double-invokes setState updater functions in development to surface
    // impure updaters. If undo/redo ever again call one stack's setter from
    // inside the other stack's updater, that nested call is a side effect
    // that fires twice under StrictMode, silently double-transferring a
    // command between the undo and redo stacks. A single undo/redo cycle
    // cannot expose that: it takes at least two edits, two undos, and two
    // redos for the corruption to produce a wrong final value.
    const { result } = renderHook(
      () => useImportDraft(draftFromParse(parseGeoJson(DOCUMENT), 'cities.geojson', 1234)),
      { wrapper: StrictMode },
    )
    act(() => result.current.setCellValue('0', 'name', 'A'))
    act(() => result.current.setCellValue('0', 'name', 'B'))
    act(() => result.current.undo())
    act(() => result.current.undo())
    expect(result.current.draft!.features[0]!.properties.name).toBe('Beijing')
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.redo())
    expect(result.current.draft!.features[0]!.properties.name).toBe('A')
    act(() => result.current.redo())
    expect(result.current.draft!.features[0]!.properties.name).toBe('B')
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)
  })

  it('a new edit clears the redo stack', () => {
    const { result } = start()
    act(() => result.current.setCellValue('0', 'name', 'A'))
    act(() => result.current.undo())
    act(() => result.current.setCellValue('0', 'name', 'B'))
    expect(result.current.canRedo).toBe(false)
  })

  it('adds a column that is absent on every feature until edited', () => {
    const { result } = start()
    act(() => {
      result.current.addColumn('note')
    })
    expect(result.current.draft!.columns.map((c) => c.name)).toContain('note')
    expect('note' in result.current.draft!.features[0]!.properties).toBe(false)

    act(() => result.current.setCellValue('0', 'note', 'checked'))
    expect(result.current.draft!.features[0]!.properties.note).toBe('checked')
  })

  it('rejects an empty or duplicate column name', () => {
    const { result } = start()
    let outcome: { ok: boolean; message?: string } = { ok: true }
    act(() => {
      outcome = result.current.addColumn('   ')
    })
    expect(outcome.ok).toBe(false)
    act(() => {
      outcome = result.current.addColumn('name')
    })
    expect(outcome.ok).toBe(false)
  })

  it('renames a column, preserving its values and position', () => {
    const { result } = start()
    act(() => {
      result.current.renameColumn('pop', 'population')
    })
    expect(result.current.draft!.columns.map((c) => c.name)).toEqual(['name', 'population'])
    expect(result.current.draft!.features[0]!.properties.population).toBe(21540000)
    expect('pop' in result.current.draft!.features[0]!.properties).toBe(false)
  })

  it('undoes a rename', () => {
    const { result } = start()
    act(() => {
      result.current.renameColumn('pop', 'population')
    })
    act(() => result.current.undo())
    expect(result.current.draft!.columns.map((c) => c.name)).toEqual(['name', 'pop'])
    expect(result.current.draft!.features[0]!.properties.pop).toBe(21540000)
  })

  it('rejects renaming onto an existing column name', () => {
    const { result } = start()
    let outcome: { ok: boolean; message?: string } = { ok: true }
    act(() => {
      outcome = result.current.renameColumn('pop', 'name')
    })
    expect(outcome.ok).toBe(false)
    expect(result.current.draft!.columns).toHaveLength(2)
  })

  it('deletes selected features as one undoable command', () => {
    const { result } = start()
    act(() => result.current.deleteFeatures(['0']))
    expect(result.current.draft!.features).toHaveLength(1)
    act(() => result.current.undo())
    expect(result.current.draft!.features).toHaveLength(2)
    expect(result.current.draft!.features[0]!.id).toBe('0')
  })

  it('serialises to a FeatureCollection preserving nesting and nulls', () => {
    const nested = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { meta: { a: [1, 2] }, empty: null },
        },
      ],
    })
    const { result } = renderHook(() =>
      useImportDraft(draftFromParse(parseGeoJson(nested), 'x.geojson', 10)),
    )
    const collection = result.current.toFeatureCollection()
    expect(collection.type).toBe('FeatureCollection')
    expect(collection.features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { meta: { a: [1, 2] }, empty: null },
      },
    ])
  })
})

describe('useImportDraft in records mode', () => {
  const rows = JSON.stringify([
    { city: 'Beijing', lon: 116.4, lat: 39.9 },
    { city: 'Lhasa', lon: 91.1, lat: 29.6 },
  ])
  const startRecords = () =>
    renderHook(() => useImportDraft(draftFromParse(parseGeoJson(rows), 'rows.json', 99)))

  it('rebuilds geometry when a coordinate cell is edited', () => {
    const { result } = startRecords()
    act(() => result.current.setCellValue('0', 'lat', 40.5))
    expect(result.current.draft!.features[0]!.geometry).toEqual({
      type: 'Point',
      coordinates: [116.4, 40.5],
    })
  })

  it('rebuilds geometry when the coordinate columns change', () => {
    const { result } = startRecords()
    act(() => result.current.setGeometryColumns(null, null))
    expect(result.current.draft!.features[0]!.geometry).toBeNull()
    act(() => result.current.setGeometryColumns('lon', 'lat'))
    expect(result.current.draft!.features[0]!.geometry).not.toBeNull()
  })
})
