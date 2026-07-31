/**
 * In-memory import draft with undo/redo.
 *
 * The draft is not server state (TanStack Query) and not shared UI state
 * (layerStore) -- it belongs to the preview and dies with it. Keeping it in
 * component state is what makes "cancel leaves no trace" trivially true.
 *
 * Every mutation is expressed as a command that carries its own inverse, so
 * undo is a pop rather than a diff against a snapshot of the whole draft.
 */

import { useCallback, useMemo, useState } from 'react'

import {
  buildPointGeometry,
  type DetectedFormat,
  type DraftColumn,
  type DraftFeature,
  type ParseResult,
} from './parseGeoJson'

export interface ImportDraft {
  fileName: string
  fileSize: number
  detectedFormat: DetectedFormat
  columns: DraftColumn[]
  features: DraftFeature[]
  geometryTypes: string[]
  lonColumn: string | null
  latColumn: string | null
}

export function draftFromParse(
  result: ParseResult,
  fileName: string,
  fileSize: number,
): ImportDraft {
  return {
    fileName,
    fileSize,
    detectedFormat: result.detectedFormat,
    columns: result.columns,
    features: result.features,
    geometryTypes: result.geometryTypes,
    lonColumn: result.lonColumn,
    latColumn: result.latColumn,
  }
}

/** A draft derives geometry from properties only for plain-JSON roots. */
const derivesGeometry = (draft: ImportDraft): boolean =>
  draft.detectedFormat === 'array' || draft.detectedFormat === 'records'

function withDerivedGeometry(draft: ImportDraft): ImportDraft {
  if (!derivesGeometry(draft)) return draft
  const features = draft.features.map((feature) => ({
    ...feature,
    geometry: buildPointGeometry(feature.properties, draft.lonColumn, draft.latColumn),
  }))
  const geometryTypes = features.some((feature) => feature.geometry) ? ['Point'] : []
  return { ...draft, features, geometryTypes }
}

/**
 * Undo replays the surviving stack from `base` rather than applying an
 * inverse, so a command only needs `apply`. That is why every `apply` must be
 * a pure function of the draft it receives -- it will be re-run on every
 * render that follows an undo.
 */
interface Command {
  apply: (draft: ImportDraft) => ImportDraft
}

const nameTaken = (draft: ImportDraft, name: string) =>
  draft.columns.some((column) => column.name === name)

/**
 * Undo and redo stacks are kept in one state value and updated with a single
 * `setState` call per action. Updating them via two separate `useState`
 * calls -- with `undo`/`redo` nesting a `setRedoStack`/`setUndoStack` call
 * inside the other stack's updater function -- looks equivalent but is not:
 * React (in `StrictMode`, which `main.tsx` wraps the app in) invokes a
 * `setState` updater function twice to help surface impure updaters, and a
 * `setState` call nested inside another updater is a side effect that then
 * runs twice too, silently double-transferring a command between the
 * stacks. Keeping both stacks in one value makes each action a single, pure,
 * idempotent updater with no nested `setState` calls to double-invoke.
 */
interface Stacks {
  undo: Command[]
  redo: Command[]
}

const EMPTY_STACKS: Stacks = { undo: [], redo: [] }

export function useImportDraft(initial: ImportDraft | null) {
  const [base] = useState(initial)
  const [stacks, setStacks] = useState<Stacks>(EMPTY_STACKS)
  const { undo: undoStack, redo: redoStack } = stacks

  const draft = useMemo(() => {
    if (!base) return null
    return undoStack.reduce((current, command) => command.apply(current), base)
  }, [base, undoStack])

  const push = useCallback((command: Command) => {
    // A new edit invalidates any redo future.
    setStacks((current) => ({ undo: [...current.undo, command], redo: [] }))
  }, [])

  const setCellValue = useCallback(
    (featureId: string, column: string, value: unknown) => {
      push({
        apply: (current) =>
          withDerivedGeometry({
            ...current,
            features: current.features.map((feature) =>
              feature.id === featureId
                ? { ...feature, properties: { ...feature.properties, [column]: value } }
                : feature,
            ),
          }),
      })
    },
    [push],
  )

  const addColumn = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!draft) return { ok: false, message: 'No draft loaded' }
      if (!trimmed) return { ok: false, message: 'Column name cannot be empty' }
      if (nameTaken(draft, trimmed)) return { ok: false, message: `"${trimmed}" already exists` }

      const column: DraftColumn = { name: trimmed, type: 'text', mixed: false }
      push({ apply: (current) => ({ ...current, columns: [...current.columns, column] }) })
      return { ok: true }
    },
    [draft, push],
  )

  const renameColumn = useCallback(
    (from: string, to: string) => {
      const trimmed = to.trim()
      if (!draft) return { ok: false, message: 'No draft loaded' }
      if (!trimmed) return { ok: false, message: 'Column name cannot be empty' }
      if (trimmed === from) return { ok: true }
      if (nameTaken(draft, trimmed)) return { ok: false, message: `"${trimmed}" already exists` }

      const rename = (current: ImportDraft, before: string, after: string): ImportDraft =>
        withDerivedGeometry({
          ...current,
          columns: current.columns.map((column) =>
            column.name === before ? { ...column, name: after } : column,
          ),
          features: current.features.map((feature) => {
            if (!(before in feature.properties)) return feature
            // Rebuild in order so the renamed key keeps its position.
            const properties: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(feature.properties)) {
              properties[key === before ? after : key] = value
            }
            return { ...feature, properties }
          }),
          lonColumn: current.lonColumn === before ? after : current.lonColumn,
          latColumn: current.latColumn === before ? after : current.latColumn,
        })

      push({ apply: (current) => rename(current, from, trimmed) })
      return { ok: true }
    },
    [draft, push],
  )

  const deleteFeatures = useCallback(
    (featureIds: string[]) => {
      if (featureIds.length === 0) return
      const ids = new Set(featureIds)
      // Filtering (rather than splicing by captured index) is what keeps undo
      // order-correct: replaying from `base` reproduces the original order for
      // free, with no positions to restore.
      push({
        apply: (current) => ({
          ...current,
          features: current.features.filter((feature) => !ids.has(feature.id)),
        }),
      })
    },
    [push],
  )

  const setGeometryColumns = useCallback(
    (lon: string | null, lat: string | null) => {
      push({
        apply: (current) => withDerivedGeometry({ ...current, lonColumn: lon, latColumn: lat }),
      })
    },
    [push],
  )

  const undo = useCallback(() => {
    setStacks((current) => {
      if (current.undo.length === 0) return current
      const command = current.undo[current.undo.length - 1]!
      return { undo: current.undo.slice(0, -1), redo: [...current.redo, command] }
    })
  }, [])

  const redo = useCallback(() => {
    setStacks((current) => {
      if (current.redo.length === 0) return current
      const command = current.redo[current.redo.length - 1]!
      return { undo: [...current.undo, command], redo: current.redo.slice(0, -1) }
    })
  }, [])

  const toFeatureCollection = useCallback(
    () => ({
      type: 'FeatureCollection' as const,
      features: (draft?.features ?? []).map((feature) => ({
        type: 'Feature',
        geometry: feature.geometry,
        properties: feature.properties,
      })),
    }),
    [draft],
  )

  return {
    draft,
    isDirty: undoStack.length > 0,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    setCellValue,
    addColumn,
    renameColumn,
    deleteFeatures,
    setGeometryColumns,
    undo,
    redo,
    toFeatureCollection,
  }
}
