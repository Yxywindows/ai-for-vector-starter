import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'

import {
  exportDownloadUrl,
  submitRasterExport,
  submitVectorExport,
  type VectorExportFormat,
} from '../api/exports'
import { getFields } from '../api/features'
import { getProject, listProjects } from '../api/layers'
import { listTasks } from '../api/tasks'
import type { Task } from '../api/types'

const VECTOR_FORMATS: { id: VectorExportFormat; name: string; hint: string }[] = [
  { id: 'geojson', name: 'GeoJSON', hint: 'web-friendly, one file' },
  { id: 'gpkg', name: 'GeoPackage', hint: 'best for desktop GIS' },
  { id: 'shp', name: 'Shapefile (ZIP)', hint: 'legacy tools' },
  { id: 'csv', name: 'CSV', hint: 'attributes + WKT geometry' },
]

const isExportTask = (task: Task) => task.kind.startsWith('export_')

const formatSize = (bytes: number) => {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export function ExportsPage() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const [projectId, setProjectId] = useState('')
  const effectiveProject = projectId || projects.data?.[0]?.id || ''

  const project = useQuery({
    queryKey: ['project', effectiveProject],
    queryFn: () => getProject(effectiveProject),
    enabled: Boolean(effectiveProject),
  })
  const exportableLayers = (project.data?.layers ?? []).filter(
    (layer) =>
      (layer.kind === 'vector' && layer.source.type === 'postgis') || layer.kind === 'raster',
  )

  const [layerId, setLayerId] = useState('')
  const [format, setFormat] = useState<VectorExportFormat>('geojson')
  const [crs, setCrs] = useState('4326')
  const [filename, setFilename] = useState('')
  // Empty set = every field rides along; checkboxes subtract from that.
  const [excludedFields, setExcludedFields] = useState<Set<string>>(new Set())
  const [submitted, setSubmitted] = useState<Task | null>(null)

  const selectedLayer = exportableLayers.find((layer) => layer.id === layerId)
  const isVector = selectedLayer?.kind === 'vector'

  const fields = useQuery({
    queryKey: ['fields', layerId],
    queryFn: () => getFields(layerId),
    enabled: Boolean(layerId && isVector),
  })
  const fieldNames = (fields.data?.fields ?? []).map((column) => column.name)

  const exportsList = useQuery({
    queryKey: ['tasks', 'exports', effectiveProject],
    queryFn: () => listTasks({ projectId: effectiveProject, pageSize: 50 }),
    enabled: Boolean(effectiveProject),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some(
        (task) => isExportTask(task) && ['queued', 'running', 'cancelling'].includes(task.state),
      )
        ? 1500
        : 8000,
    select: (page) => page.items.filter(isExportTask),
  })

  const submit = useMutation({
    mutationFn: () => {
      if (!isVector) {
        return submitRasterExport(effectiveProject, {
          layerId,
          filename: filename || undefined,
        })
      }
      const included = fieldNames.filter((name) => !excludedFields.has(name))
      return submitVectorExport(effectiveProject, {
        layerId,
        format,
        crs: Number(crs),
        filename: filename || undefined,
        fields: excludedFields.size > 0 ? included : undefined,
      })
    },
    onSuccess: (task) => {
      setSubmitted(task)
      void exportsList.refetch()
    },
  })

  const crsValid = Number.isInteger(Number(crs)) && Number(crs) > 0
  const canSubmit =
    Boolean(effectiveProject && layerId) &&
    (!isVector || crsValid) &&
    (!isVector || excludedFields.size < fieldNames.length || fieldNames.length === 0) &&
    !submit.isPending

  const chooseLayer = (id: string) => {
    setLayerId(id)
    setExcludedFields(new Set())
    setSubmitted(null)
  }

  const toggleField = (name: string) => {
    setExcludedFields((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1>Exports</h1>
        <select
          aria-label="Project"
          value={effectiveProject}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.data?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </header>

      <div className="analysis-layout">
        <section className="analysis-form" aria-label="Export configuration">
          <h2 className="eyebrow">New export</h2>
          <p className="page__note">
            Exports run in the background — submit one, keep working, download when it finishes.
          </p>

          <label className="analysis-field">
            Dataset
            <select
              aria-label="Dataset"
              value={layerId}
              onChange={(event) => chooseLayer(event.target.value)}
            >
              <option value="">Choose a dataset…</option>
              {exportableLayers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name} {layer.kind === 'raster' ? '(raster)' : ''}
                </option>
              ))}
            </select>
          </label>

          {selectedLayer && !isVector ? (
            <p className="page__note">Raster datasets export as GeoTIFF.</p>
          ) : null}

          {isVector ? (
            <>
              <label className="analysis-field">
                Format
                <select
                  aria-label="Format"
                  value={format}
                  onChange={(event) => setFormat(event.target.value as VectorExportFormat)}
                >
                  {VECTOR_FORMATS.map((spec) => (
                    <option key={spec.id} value={spec.id}>
                      {spec.name} — {spec.hint}
                    </option>
                  ))}
                </select>
              </label>

              <label className="analysis-field">
                Output CRS (EPSG)
                <input
                  type="number"
                  aria-label="Output CRS"
                  min={1}
                  value={crs}
                  onChange={(event) => setCrs(event.target.value)}
                />
              </label>

              {fieldNames.length > 0 ? (
                <fieldset className="export-fields">
                  <legend>Fields</legend>
                  {fieldNames.map((name) => (
                    <label key={name} className="export-fields__item">
                      <input
                        type="checkbox"
                        checked={!excludedFields.has(name)}
                        onChange={() => toggleField(name)}
                      />
                      {name}
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </>
          ) : null}

          <label className="analysis-field">
            File name (optional)
            <input
              type="text"
              aria-label="File name"
              placeholder={selectedLayer?.name ?? 'export'}
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
            />
          </label>

          <div className="analysis-actions">
            <button
              type="button"
              className="btn--primary"
              disabled={!canSubmit}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? 'Submitting…' : 'Start export'}
            </button>
            {submitted ? (
              <span role="status" className="analysis-submitted">
                Submitted — follow it in <Link to="/tasks">Tasks</Link> or below.
              </span>
            ) : null}
            {submit.isError ? (
              <span role="alert" className="task-error">
                {(submit.error as Error).message}
              </span>
            ) : null}
          </div>
        </section>
      </div>

      <section aria-label="Recent exports">
        <h2 className="eyebrow">Recent exports</h2>
        {exportsList.data?.length === 0 ? (
          <p className="page__empty">Nothing has been exported from this project yet.</p>
        ) : (
          <ul className="row-list">
            {exportsList.data?.map((task) => {
              const result = task.result ?? {}
              const name =
                String(result.downloadName ?? '') ||
                String(task.params.filename ?? '') ||
                task.kind.replace('export_', '')
              return (
                <li key={task.id} className="row-list__row">
                  <span className="row-list__name">{name}</span>
                  <span className={`task-state task-state--${task.state}`}>{task.state}</span>
                  <span className="row-list__meta mono">
                    {String(task.provenance.format ?? '')}
                    {task.state === 'running' && task.stage ? ` · ${task.stage}` : ''}
                    {task.state === 'succeeded' && typeof result.sizeBytes === 'number'
                      ? ` · ${formatSize(result.sizeBytes)}`
                      : ''}
                  </span>
                  {task.state === 'succeeded' ? (
                    <a className="row-list__action" href={exportDownloadUrl(task.id)} download>
                      download ▸
                    </a>
                  ) : null}
                  {task.error ? (
                    <span className="row-list__meta task-error">{task.error.code}</span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
