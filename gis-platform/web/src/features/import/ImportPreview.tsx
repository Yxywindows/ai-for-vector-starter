/**
 * The staged import workspace.
 *
 * Owns the one piece of state both the map and the grid read -- the selected
 * feature ids -- so synchronisation is a single source with two subscribers
 * rather than two stores echoing each other.
 *
 * Nothing here writes to the server until Confirm Import. Cancelling discards
 * the draft and leaves no database record, because the draft only ever existed
 * in this component.
 *
 * Split in two: `ImportPreview` resolves the limits and the parse, and only
 * then mounts `ImportWorkspace`. The split is load-bearing, not cosmetic --
 * `useImportDraft` captures its baseline on the hook's first render, so the
 * workspace must not mount until the parse result exists, or the draft would
 * be permanently null.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError } from '../../api/client'
import { confirmImportDraft, getImportLimits } from '../../api/imports'
import type { FeatureIssue, ImportResult } from '../../api/types'
import { DraftGrid } from './DraftGrid'
import { PreviewMap } from './PreviewMap'
import { ParseError, type ParseResult } from './parseGeoJson'
import { draftFromParse, useImportDraft } from './useImportDraft'
import { useParseWorker } from './useParseWorker'
import { validateDraft } from './validation'

interface ImportPreviewProps {
  projectId: string
  file: File
  onClose: () => void
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const FORMAT_LABEL: Record<string, string> = {
  featureCollection: 'GeoJSON FeatureCollection',
  feature: 'GeoJSON Feature',
  array: 'JSON array of records',
  records: 'JSON object with a records array',
}

export function ImportPreview({ projectId, file, onClose }: ImportPreviewProps) {
  const { parse } = useParseWorker()
  const limits = useQuery({ queryKey: ['import-limits'], queryFn: getImportLimits })

  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [parseFailure, setParseFailure] = useState<string | null>(null)

  // Derived, not effect state: the size verdict is a pure function of the
  // file and the fetched limits, and deriving it is also what keeps the
  // effect below from ever starting a read of an oversized file.
  const sizeFailure =
    limits.data && file.size > limits.data.maxFileBytes
      ? `"${file.name}" is ${formatBytes(file.size)}, which is too large. ` +
        `The limit is ${formatBytes(limits.data.maxFileBytes)}.`
      : null

  // Parse once the limits are known, so the size check happens before the read.
  useEffect(() => {
    if (!limits.data || sizeFailure) return
    let cancelled = false

    void file
      .text()
      .then((text) => parse(text))
      .then((value) => {
        if (!cancelled) setParsed(value)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof ParseError ? error.message : (error as Error).message
        setParseFailure(`Could not read "${file.name}": ${message}`)
      })

    return () => {
      cancelled = true
    }
  }, [file, limits.data, parse, sizeFailure])

  const failure = sizeFailure ?? parseFailure
  if (failure) {
    return (
      <div className="import-preview" role="dialog" aria-label="Import preview">
        <p role="alert">{failure}</p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    )
  }

  if (!parsed || !limits.data) {
    return (
      <div className="import-preview" role="dialog" aria-label="Import preview">
        <p>Reading {file.name}…</p>
      </div>
    )
  }

  return (
    <ImportWorkspace
      projectId={projectId}
      file={file}
      parsed={parsed}
      previewMaxFeatures={limits.data.previewMaxFeatures}
      onClose={onClose}
    />
  )
}

interface ImportWorkspaceProps {
  projectId: string
  file: File
  parsed: ParseResult
  previewMaxFeatures: number
  onClose: () => void
}

function ImportWorkspace({
  projectId,
  file,
  parsed,
  previewMaxFeatures,
  onClose,
}: ImportWorkspaceProps) {
  const queryClient = useQueryClient()

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ImportResult | null>(null)
  const [serverIssues, setServerIssues] = useState<FeatureIssue[]>([])

  const initial = useMemo(() => draftFromParse(parsed, file.name, file.size), [parsed, file])
  const editor = useImportDraft(initial)
  const draft = editor.draft

  const validation = useMemo(
    () => (draft ? validateDraft(draft.features, draft.columns) : { errors: [], warnings: [] }),
    [draft],
  )

  const needsCoordinates =
    draft !== null &&
    (draft.detectedFormat === 'array' || draft.detectedFormat === 'records') &&
    (draft.lonColumn === null || draft.latColumn === null)

  const confirm = useMutation({
    mutationFn: () =>
      confirmImportDraft(projectId, {
        name: file.name.replace(/\.[^.]+$/, ''),
        sourceFilename: file.name,
        featureCollection: editor.toFeatureCollection(),
      }),
    onSuccess: (value) => {
      setResult(value)
      setServerIssues([])
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
    onError: (error: unknown) => {
      const details = error instanceof ApiError ? error.details : null
      const issues =
        details && typeof details === 'object' && 'errors' in details
          ? ((details as { errors: FeatureIssue[] }).errors ?? [])
          : []
      setServerIssues(issues)
    },
  })

  const requestClose = useCallback(() => {
    if (editor.isDirty && !window.confirm('Discard unsaved edits and close this import?')) return
    onClose()
  }, [editor.isDirty, onClose])

  const setCellError = useCallback((featureId: string, column: string, message: string | null) => {
    setCellErrors((current) => {
      const key = `${featureId}:${column}`
      if (message === null) {
        if (!(key in current)) return current
        const next = { ...current }
        delete next[key]
        return next
      }
      return { ...current, [key]: message }
    })
  }, [])

  if (!draft) return null

  const blockingErrors = validation.errors.length > 0 || Object.keys(cellErrors).length > 0
  const numericColumns = draft.columns.filter((column) => column.type === 'number')

  return (
    <div className="import-preview" role="dialog" aria-label="Import preview">
      <header className="import-preview__header">
        <div>
          <strong>{draft.fileName}</strong>
          <span className="import-preview__meta">
            {formatBytes(draft.fileSize)} · {FORMAT_LABEL[draft.detectedFormat]} ·{' '}
            {draft.features.length} features
            {draft.geometryTypes.length > 0 ? ` · ${draft.geometryTypes.join(', ')}` : ''}
          </span>
        </div>

        {(draft.detectedFormat === 'array' || draft.detectedFormat === 'records') && (
          <div className="import-preview__coords">
            <label>
              Longitude
              <select
                value={draft.lonColumn ?? ''}
                onChange={(event) =>
                  editor.setGeometryColumns(event.target.value || null, draft.latColumn)
                }
              >
                <option value="">— none —</option>
                {numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Latitude
              <select
                value={draft.latColumn ?? ''}
                onChange={(event) =>
                  editor.setGeometryColumns(draft.lonColumn, event.target.value || null)
                }
              >
                <option value="">— none —</option>
                {numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <button type="button" aria-label="Close import preview" onClick={requestClose}>
          ×
        </button>
      </header>

      <div className="import-preview__body">
        <PreviewMap
          features={draft.features}
          selectedIds={selectedIds}
          maxRendered={previewMaxFeatures}
          onSelect={setSelectedIds}
        />

        <aside className="import-preview__issues">
          <p className="import-preview__issues-head">
            {validation.errors.length} errors · {validation.warnings.length} warnings
          </p>
          <ul>
            {[...validation.errors, ...validation.warnings].slice(0, 50).map((issue, index) => (
              <li key={`${issue.code}-${issue.featureIndex}-${index}`}>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(issue.featureIndex >= 0 ? [String(issue.featureIndex)] : [])
                  }
                >
                  {issue.featureIndex >= 0 ? `Row ${issue.featureIndex + 1}: ` : ''}
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
          {needsCoordinates ? (
            <p role="alert">Choose a longitude and latitude column before importing these records.</p>
          ) : null}
        </aside>
      </div>

      <div className="import-preview__toolbar">
        <input
          type="search"
          aria-label="Search features"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
        />
        <button
          type="button"
          onClick={() => {
            const name = window.prompt('New column name')
            if (name === null) return
            const outcome = editor.addColumn(name)
            if (!outcome.ok) window.alert(outcome.message)
          }}
        >
          Add column
        </button>
        <button
          type="button"
          onClick={() => {
            const from = window.prompt('Rename which column?')
            if (from === null) return
            const to = window.prompt(`Rename "${from}" to`)
            if (to === null) return
            const outcome = editor.renameColumn(from, to)
            if (!outcome.ok) window.alert(outcome.message)
          }}
        >
          Rename column
        </button>
        <button
          type="button"
          disabled={selectedIds.length === 0}
          onClick={() => {
            if (!window.confirm(`Delete ${selectedIds.length} selected feature(s)?`)) return
            editor.deleteFeatures(selectedIds)
            setSelectedIds([])
          }}
        >
          Delete selected
        </button>
        <button type="button" aria-label="Undo" disabled={!editor.canUndo} onClick={editor.undo}>
          ↶
        </button>
        <button type="button" aria-label="Redo" disabled={!editor.canRedo} onClick={editor.redo}>
          ↷
        </button>
        <span data-testid="preview-selection">{selectedIds.length} selected</span>
        {editor.isDirty ? <span className="import-preview__dirty">● unsaved edits</span> : null}
      </div>

      <DraftGrid
        columns={draft.columns}
        features={draft.features}
        selectedIds={selectedIds}
        search={search}
        cellErrors={cellErrors}
        onSelectionChange={setSelectedIds}
        onCellEdit={editor.setCellValue}
        onCellError={setCellError}
      />

      {serverIssues.length > 0 ? (
        <div role="alert" className="import-preview__server-errors">
          {serverIssues.slice(0, 20).map((issue, index) => (
            <p key={index}>
              {issue.featureIndex >= 0 ? `Row ${issue.featureIndex + 1}: ` : ''}
              {issue.message}
            </p>
          ))}
        </div>
      ) : confirm.isError ? (
        <p role="alert">{(confirm.error as Error).message}</p>
      ) : null}

      {result ? (
        <p className="import-preview__result">
          Imported {result.importedCount}, rejected {result.rejectedCount}, warnings{' '}
          {result.warningCount}.{' '}
          <button type="button" onClick={onClose}>
            Done
          </button>
        </p>
      ) : (
        <footer className="import-preview__actions">
          <button type="button" onClick={requestClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={confirm.isPending || blockingErrors || needsCoordinates}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? 'Importing…' : 'Confirm Import'}
          </button>
        </footer>
      )}
    </div>
  )
}
