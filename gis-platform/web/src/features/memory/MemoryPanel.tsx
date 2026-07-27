import { useQuery } from '@tanstack/react-query'

import { getMemoryReport } from '../../api/system'
import type { LayerUsage } from '../../map/memory/LayerMemoryManager'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

interface MemoryPanelProps {
  usage: LayerUsage[]
  totalBytes: number
  budgetBytes: number
  names: Map<string, string>
}

export function MemoryPanel({ usage, totalBytes, budgetBytes, names }: MemoryPanelProps) {
  const server = useQuery({
    queryKey: ['system-memory'],
    queryFn: getMemoryReport,
    refetchInterval: 5000,
  })
  const percent = Math.round((totalBytes / budgetBytes) * 100)

  return (
    <section className="memory-panel">
      <h3>Memory</h3>
      <p>
        Browser: {formatBytes(totalBytes)} of {formatBytes(budgetBytes)} ({percent}%)
      </p>
      <ul className="memory-panel__list">
        {usage.map((entry) => (
          <li key={entry.layerId} data-testid="memory-row">
            <span>{names.get(entry.layerId) ?? entry.layerId}</span>
            <span>{formatBytes(entry.bytes)}</span>
            {entry.pinned ? (
              <span aria-label={`${names.get(entry.layerId) ?? entry.layerId} is pinned`}>📌</span>
            ) : null}
          </li>
        ))}
      </ul>

      {server.data ? (
        <>
          <h4>Server</h4>
          <p>
            Raster handles: {server.data.rasterPool.openHandles} / {server.data.rasterPool.maxOpen}{' '}
            open
          </p>
          <p>
            Hits {server.data.rasterPool.hits} · misses {server.data.rasterPool.misses} · evictions{' '}
            {server.data.rasterPool.evictions}
          </p>
          <p>Process RSS: {formatBytes(server.data.processRssBytes)}</p>
        </>
      ) : null}
    </section>
  )
}
