import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'

import { exportDownloadUrl } from '../api/exports'
import { cancelTask, getTaskLogs, listTasks, retryTask } from '../api/tasks'
import type { Task, TaskState } from '../api/types'

const ACTIVE_STATES: ReadonlySet<TaskState> = new Set(['queued', 'running', 'cancelling'])
const STATES: TaskState[] = ['queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled']

const KIND_LABELS: Record<string, string> = {
  vector_import: 'Vector import',
  draft_import: 'Staged import',
  raster_import: 'Raster import',
  export_vector: 'Vector export',
  export_raster: 'Raster export',
  analysis_buffer: 'Buffer',
  analysis_clip: 'Clip',
  analysis_intersection: 'Intersection',
  analysis_dissolve: 'Dissolve',
  analysis_spatial_join: 'Spatial join',
  analysis_validate_repair: 'Validate & repair',
  analysis_point_in_polygon: 'Point in polygon',
}

/** Poll fast while anything is executing, slowly when the list is settled.
 * The transport lives in this one query; swapping polling for SSE later
 * touches nothing but this file. */
const POLL_ACTIVE_MS = 1500
const POLL_IDLE_MS = 8000

const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function TaskRow({ task }: { task: Task }) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['tasks'] })
  const cancel = useMutation({ mutationFn: () => cancelTask(task.id), onSuccess: invalidate })
  const retry = useMutation({ mutationFn: () => retryTask(task.id), onSuccess: invalidate })
  const logs = useQuery({
    queryKey: ['task-logs', task.id, task.updatedAt],
    queryFn: () => getTaskLogs(task.id),
    enabled: expanded,
  })

  const active = ACTIVE_STATES.has(task.state)
  const cancellable = task.state === 'queued' || task.state === 'running'
  const layerId = task.layerId ?? (task.result?.layerId as string | undefined)

  return (
    <>
      <tr className="task-row" data-testid={`task-${task.id}`}>
        <td>
          <span className="task-row__kind">{kindLabel(task.kind)}</span>
          {task.retryOf ? <span className="task-row__retry-tag">retry</span> : null}
        </td>
        <td>
          {task.projectName ?? '—'}
          {typeof task.provenance.sourceFilename === 'string' ? (
            <span className="task-row__source mono">{task.provenance.sourceFilename}</span>
          ) : null}
        </td>
        <td>
          <span className={`task-state task-state--${task.state}`}>{task.state}</span>
        </td>
        <td className="task-row__progress-cell">
          <div
            className="task-progress"
            role="progressbar"
            aria-valuenow={Math.round(task.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${Math.round(task.progress * 100)}%` }} />
          </div>
          <span className="mono task-row__percent">
            {Math.round(task.progress * 100)}%{active && task.stage ? ` · ${task.stage}` : ''}
          </span>
        </td>
        <td className="mono">{new Date(task.createdAt).toLocaleString()}</td>
        <td className="mono">{formatDuration(task.durationMs)}</td>
        <td className="task-row__actions">
          {cancellable ? (
            <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel
            </button>
          ) : null}
          {task.retryable ? (
            <button type="button" onClick={() => retry.mutate()} disabled={retry.isPending}>
              Retry
            </button>
          ) : null}
          {task.state === 'succeeded' && task.kind.startsWith('export_') ? (
            <a className="row-list__action" href={exportDownloadUrl(task.id)} download>
              download ▸
            </a>
          ) : task.state === 'succeeded' && layerId ? (
            <Link className="row-list__action" to={`/data/${layerId}`}>
              result ▸
            </Link>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            aria-expanded={expanded}
            aria-label={`Toggle details for ${kindLabel(task.kind)}`}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </td>
      </tr>
      {task.error ? (
        <tr className="task-detail-row">
          <td colSpan={7}>
            <p className="task-error" role="alert">
              <span className="mono">{task.error.code}</span> — {task.error.message}
            </p>
          </td>
        </tr>
      ) : null}
      {expanded ? (
        <tr className="task-detail-row">
          <td colSpan={7}>
            <div className="task-logs" data-testid={`task-logs-${task.id}`}>
              {logs.data?.entries?.length ? (
                logs.data.entries.map((entry, index) => (
                  <p key={index} className={entry.level === 'error' ? 'task-logs__error' : undefined}>
                    <span className="mono">{new Date(entry.ts).toLocaleTimeString()}</span>{' '}
                    {entry.message}
                  </p>
                ))
              ) : (
                <p>{logs.isLoading ? 'Loading logs…' : 'No log entries.'}</p>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

export function TasksPage() {
  const [state, setState] = useState('')
  const [kind, setKind] = useState('')
  const [page, setPage] = useState(1)

  const tasks = useQuery({
    queryKey: ['tasks', state, kind, page],
    queryFn: ({ signal }) =>
      listTasks({
        state: state || undefined,
        type: kind || undefined,
        page,
        pageSize: 20,
        signal,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? []
      return items.some((task) => ACTIVE_STATES.has(task.state)) ? POLL_ACTIVE_MS : POLL_IDLE_MS
    },
  })

  // Belt to apiFetch's suspenders: never trust the payload shape enough
  // to crash the page over it.
  const items = tasks.data?.items ?? []
  const kinds = [...new Set(items.map((task) => task.kind))]
  const totalPages = Math.max(1, Math.ceil((tasks.data?.total ?? 0) / 20))

  return (
    <div className="page page--wide">
      <header className="page__header">
        <h1>Tasks</h1>
      </header>

      <div className="page__toolbar">
        <select aria-label="Filter by state" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {STATES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {kindLabel(value)}
            </option>
          ))}
        </select>
        <span className="page__count mono">
          {tasks.data?.total ?? 0} tasks · page {page}/{totalPages}
        </span>
        <button type="button" className="icon-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          ‹
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          ›
        </button>
      </div>

      {tasks.isError ? (
        <p className="task-error" role="alert">
          Could not load tasks: {(tasks.error as Error).message}
        </p>
      ) : tasks.data && items.length === 0 ? (
        <p className="page__empty">
          No tasks yet. Imports create them — start one from the map workspace's <em>Add layer</em>.
        </p>
      ) : (
        <table className="data-table data-table--tasks">
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Project / source</th>
              <th scope="col">Status</th>
              <th scope="col">Progress</th>
              <th scope="col">Created</th>
              <th scope="col">Duration</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {items.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
