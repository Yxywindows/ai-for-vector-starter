import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'

import { submitAnalysis, type AnalysisTool } from '../api/analysis'
import { getProject, listProjects } from '../api/layers'
import { listTasks } from '../api/tasks'
import type { Layer, Task } from '../api/types'

interface ToolSpec {
  id: AnalysisTool
  name: string
  description: string
}

const TOOLS: ToolSpec[] = [
  { id: 'buffer', name: 'Buffer', description: 'Grow features by a distance in meters.' },
  { id: 'clip', name: 'Clip', description: 'Keep the parts inside a mask layer.' },
  { id: 'intersection', name: 'Intersection', description: 'Pairwise overlap of two layers.' },
  { id: 'dissolve', name: 'Dissolve', description: 'Merge features, optionally by a field.' },
  { id: 'spatial-join', name: 'Spatial join', description: 'Attach attributes from another layer.' },
  {
    id: 'validate-repair',
    name: 'Validate & repair',
    description: 'Fix invalid geometries with ST_MakeValid.',
  },
  {
    id: 'point-in-polygon',
    name: 'Point in polygon',
    description: 'Count points inside each polygon.',
  },
]

const isAnalysisTask = (task: Task) => task.kind.startsWith('analysis_')

function LayerSelect({
  label,
  layers,
  value,
  onChange,
}: {
  label: string
  layers: Layer[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <label className="analysis-field">
      {label}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose a layer…</option>
        {layers.map((layer) => (
          <option key={layer.id} value={layer.id}>
            {layer.name}
          </option>
        ))}
      </select>
    </label>
  )
}

export function AnalysisPage() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const [projectId, setProjectId] = useState('')
  const effectiveProject = projectId || projects.data?.[0]?.id || ''

  const project = useQuery({
    queryKey: ['project', effectiveProject],
    queryFn: () => getProject(effectiveProject),
    enabled: Boolean(effectiveProject),
  })
  const vectorLayers = (project.data?.layers ?? []).filter(
    (layer) => layer.kind === 'vector' && layer.source.type === 'postgis',
  )

  const [tool, setTool] = useState<AnalysisTool>('buffer')
  const [primary, setPrimary] = useState('')
  const [secondary, setSecondary] = useState('')
  const [distance, setDistance] = useState('1000')
  const [byField, setByField] = useState('')
  const [predicate, setPredicate] = useState('intersects')
  const [outputName, setOutputName] = useState('')
  const [submitted, setSubmitted] = useState<Task | null>(null)

  const runs = useQuery({
    queryKey: ['tasks', 'analysis', effectiveProject],
    queryFn: () => listTasks({ projectId: effectiveProject, pageSize: 50 }),
    enabled: Boolean(effectiveProject),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some(
        (task) => isAnalysisTask(task) && ['queued', 'running', 'cancelling'].includes(task.state),
      )
        ? 1500
        : 8000,
    select: (page) => page.items.filter(isAnalysisTask),
  })

  const needsSecondary = tool === 'clip' || tool === 'intersection' || tool === 'spatial-join'
  const needsPoints = tool === 'point-in-polygon'

  const submit = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { outputName }
      if (tool === 'buffer') {
        Object.assign(body, { layerId: primary, distanceMeters: Number(distance) })
      } else if (tool === 'clip') {
        Object.assign(body, { layerId: primary, maskLayerId: secondary })
      } else if (tool === 'intersection') {
        Object.assign(body, { layerId: primary, otherLayerId: secondary })
      } else if (tool === 'dissolve') {
        Object.assign(body, { layerId: primary, byField: byField || null })
      } else if (tool === 'spatial-join') {
        Object.assign(body, { targetLayerId: primary, joinLayerId: secondary, predicate })
      } else if (tool === 'validate-repair') {
        Object.assign(body, { layerId: primary })
      } else {
        Object.assign(body, { pointsLayerId: primary, polygonsLayerId: secondary })
      }
      return submitAnalysis(effectiveProject, tool, body)
    },
    onSuccess: (task) => {
      setSubmitted(task)
      void runs.refetch()
    },
  })

  const canSubmit =
    Boolean(effectiveProject && primary && outputName) &&
    (!needsSecondary || Boolean(secondary)) &&
    (!needsPoints || Boolean(secondary)) &&
    (tool !== 'buffer' || Number(distance) > 0) &&
    !submit.isPending

  return (
    <div className="page">
      <header className="page__header">
        <h1>Analysis</h1>
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
        <nav className="analysis-tools" aria-label="Analysis tools">
          {TOOLS.map((spec) => (
            <button
              key={spec.id}
              type="button"
              aria-pressed={tool === spec.id}
              onClick={() => {
                setTool(spec.id)
                setSubmitted(null)
              }}
            >
              {spec.name}
            </button>
          ))}
        </nav>

        <section className="analysis-form" aria-label="Tool configuration">
          <h2 className="eyebrow">{TOOLS.find((spec) => spec.id === tool)?.name}</h2>
          <p className="page__note">{TOOLS.find((spec) => spec.id === tool)?.description}</p>

          <LayerSelect
            label={
              tool === 'spatial-join'
                ? 'Target layer'
                : tool === 'point-in-polygon'
                  ? 'Points layer'
                  : 'Input layer'
            }
            layers={vectorLayers}
            value={primary}
            onChange={setPrimary}
          />

          {needsSecondary || needsPoints ? (
            <LayerSelect
              label={
                tool === 'clip'
                  ? 'Mask layer'
                  : tool === 'spatial-join'
                    ? 'Join layer'
                    : tool === 'point-in-polygon'
                      ? 'Polygons layer'
                      : 'Other layer'
              }
              layers={vectorLayers}
              value={secondary}
              onChange={setSecondary}
            />
          ) : null}

          {tool === 'buffer' ? (
            <label className="analysis-field">
              Distance (meters)
              <input
                type="number"
                aria-label="Distance in meters"
                min={0.1}
                step="any"
                value={distance}
                onChange={(event) => setDistance(event.target.value)}
              />
            </label>
          ) : null}

          {tool === 'dissolve' ? (
            <label className="analysis-field">
              Dissolve by field (optional)
              <input
                type="text"
                aria-label="Dissolve by field"
                placeholder="leave empty to merge everything"
                value={byField}
                onChange={(event) => setByField(event.target.value)}
              />
            </label>
          ) : null}

          {tool === 'spatial-join' ? (
            <label className="analysis-field">
              Predicate
              <select
                aria-label="Join predicate"
                value={predicate}
                onChange={(event) => setPredicate(event.target.value)}
              >
                <option value="intersects">intersects</option>
                <option value="contains">contains</option>
                <option value="within">within</option>
              </select>
            </label>
          ) : null}

          <label className="analysis-field">
            Output dataset name
            <input
              type="text"
              aria-label="Output dataset name"
              value={outputName}
              onChange={(event) => setOutputName(event.target.value)}
            />
          </label>

          <div className="analysis-actions">
            <button
              type="button"
              className="btn--primary"
              disabled={!canSubmit}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? 'Submitting…' : 'Run analysis'}
            </button>
            {submitted ? (
              <span role="status" className="analysis-submitted">
                Submitted — follow it in <Link to="/tasks">Tasks</Link>.
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

      <section aria-label="Recent analysis runs">
        <h2 className="eyebrow">Recent runs</h2>
        {runs.data?.length === 0 ? (
          <p className="page__empty">No analysis has run in this project yet.</p>
        ) : (
          <ul className="row-list">
            {runs.data?.map((task) => (
              <li key={task.id} className="row-list__row">
                <span className="row-list__name">
                  {String(task.provenance.outputName ?? task.kind.replace('analysis_', ''))}
                </span>
                <span className={`task-state task-state--${task.state}`}>{task.state}</span>
                <span className="row-list__meta mono">
                  {task.kind.replace('analysis_', '')}
                  {task.state === 'running' && task.stage ? ` · ${task.stage}` : ''}
                </span>
                {task.state === 'succeeded' && task.layerId ? (
                  <>
                    <Link className="row-list__action" to={`/data/${task.layerId}`}>
                      dataset ▸
                    </Link>
                    <Link
                      className="row-list__action"
                      to={`/projects/${task.projectId}/map`}
                    >
                      open on map ▸
                    </Link>
                  </>
                ) : null}
                {task.error ? (
                  <span className="row-list__meta task-error">{task.error.code}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
