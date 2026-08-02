import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as tasksApi from '../api/tasks'
import type { Task, TaskState } from '../api/types'
import { TasksPage } from './TasksPage'

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: 'p1',
    projectName: 'Walkthrough',
    layerId: null,
    kind: 'vector_import',
    state: 'queued',
    progress: 0,
    stage: null,
    params: {},
    result: null,
    error: null,
    retryOf: null,
    retryable: false,
    cancelRequested: false,
    provenance: { sourceFilename: 'cities.geojson' },
    createdAt: '2026-08-02T10:00:00Z',
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-08-02T10:00:00Z',
    durationMs: null,
    ...overrides,
  }
}

const EVERY_STATE: Task[] = (
  ['queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled'] as TaskState[]
).map((state, index) =>
  makeTask({
    id: `t-${state}`,
    state,
    progress: state === 'succeeded' ? 1 : state === 'running' ? 0.55 : 0,
    stage: state === 'running' ? 'writing' : null,
    layerId: state === 'succeeded' ? `layer-${index}` : null,
    result: state === 'succeeded' ? { layerId: `layer-${index}` } : null,
    error:
      state === 'failed'
        ? { code: 'upstream_data_error', message: 'Could not read the file' }
        : null,
    retryable: state === 'failed' || state === 'cancelled',
    durationMs: state === 'succeeded' ? 1234 : null,
  }),
)

function renderPage(client?: QueryClient) {
  const queryClient =
    client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(tasksApi, 'listTasks').mockResolvedValue({
    items: EVERY_STATE,
    total: EVERY_STATE.length,
    page: 1,
    pageSize: 20,
  })
  vi.spyOn(tasksApi, 'getTaskLogs').mockResolvedValue({
    taskId: 't-succeeded',
    entries: [{ ts: '2026-08-02T10:00:01Z', level: 'info', message: 'reading cities.geojson' }],
  })
})

afterEach(() => vi.restoreAllMocks())

describe('TasksPage', () => {
  it('renders a row for every lifecycle state with real progress', async () => {
    renderPage()
    await screen.findByTestId('task-t-queued')
    const table = screen.getByRole('table')
    for (const state of ['queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled']) {
      expect(within(table).getByText(state)).toBeInTheDocument()
    }
    // Real progress, not a timer: the running task reports its stage.
    expect(screen.getByText(/55% · writing/)).toBeInTheDocument()
    // Structured error summary is visible without expanding.
    expect(screen.getByRole('alert')).toHaveTextContent(/upstream_data_error/)
    expect(screen.getByRole('alert')).toHaveTextContent(/could not read/i)
    // The succeeded task links to its produced dataset.
    expect(screen.getByRole('link', { name: /result/ })).toHaveAttribute(
      'href',
      '/data/layer-2',
    )
  })

  it('gives succeeded exports a download link instead of a dataset link', async () => {
    vi.spyOn(tasksApi, 'listTasks').mockResolvedValue({
      items: [
        makeTask({
          id: 't-export',
          kind: 'export_vector',
          state: 'succeeded',
          layerId: 'layer-source',
          result: { downloadName: 'cities.geojson', sizeBytes: 10 },
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    renderPage()
    await screen.findByTestId('task-t-export')
    const table = screen.getByRole('table')
    expect(within(table).getByText('Vector export')).toBeInTheDocument()
    const download = within(table).getByRole('link', { name: /download/ })
    expect(download).toHaveAttribute('href', '/api/v1/tasks/t-export/download')
    expect(download).toHaveAttribute('download')
    expect(screen.queryByRole('link', { name: /result/ })).not.toBeInTheDocument()
  })

  it('offers cancel only where the lifecycle allows it', async () => {
    renderPage()
    await screen.findByTestId('task-t-queued')
    const cancels = screen.getAllByRole('button', { name: 'Cancel' })
    expect(cancels).toHaveLength(2) // queued + running, never terminal states
    const retries = screen.getAllByRole('button', { name: 'Retry' })
    expect(retries).toHaveLength(2) // failed + cancelled (both retryable here)
  })

  it('requests cancellation and refreshes the list', async () => {
    const spy = vi
      .spyOn(tasksApi, 'cancelTask')
      .mockResolvedValue(makeTask({ id: 't-queued', state: 'cancelled' }))
    renderPage()
    await screen.findByTestId('task-t-queued')
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('t-queued'))
  })

  it('retries a failed task', async () => {
    const spy = vi
      .spyOn(tasksApi, 'retryTask')
      .mockResolvedValue(makeTask({ id: 'fresh', state: 'queued', retryOf: 't-failed' }))
    renderPage()
    await screen.findByTestId('task-t-failed')
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('t-failed'))
  })

  it('expands a row to show its logs', async () => {
    renderPage()
    await screen.findByTestId('task-t-succeeded')
    await userEvent.click(
      screen.getAllByRole('button', { name: /toggle details/i })[2]!, // the succeeded row
    )
    expect(await screen.findByText(/reading cities.geojson/)).toBeInTheDocument()
  })

  it('stops polling after unmount', async () => {
    vi.useFakeTimers()
    try {
      const { unmount } = renderPage()
      // Let the initial fetch settle under fake timers.
      await vi.waitFor(() => expect(tasksApi.listTasks).toHaveBeenCalled())
      const callsBefore = vi.mocked(tasksApi.listTasks).mock.calls.length

      unmount()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(vi.mocked(tasksApi.listTasks).mock.calls.length).toBe(callsBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never touches the map engine', async () => {
    const { container } = renderPage()
    await screen.findByTestId('task-t-queued')
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('.ol-viewport')).toBeNull()
  })
})
