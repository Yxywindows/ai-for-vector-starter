import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { listPostgisTables } from '../api/catalog'
import { getProject, listProjects } from '../api/layers'
import type { Layer } from '../api/types'

interface CatalogRow {
  key: string
  name: string
  kind: string
  geometry: string
  features: number | null
  projectId: string | null
  projectName: string
  layerId: string | null
}

export function DataCatalogPage() {
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')

  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const projectQueries = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: ['project', project.id],
      queryFn: () => getProject(project.id),
    })),
  })
  const tables = useQuery({ queryKey: ['postgis-tables'], queryFn: listPostgisTables })

  const rows = useMemo<CatalogRow[]>(() => {
    const layerRows: CatalogRow[] = projectQueries.flatMap((query) => {
      const project = query.data
      if (!project) return []
      return project.layers.map(
        (layer: Layer): CatalogRow => ({
          key: layer.id,
          name: layer.name,
          kind: layer.kind,
          geometry: layer.geometryType ?? '—',
          features: layer.featureCount,
          projectId: project.id,
          projectName: project.name,
          layerId: layer.id,
        }),
      )
    })
    const registered = new Set(
      layerRows.map((row) => row.name.toLowerCase()), // heuristic label only
    )
    const tableRows: CatalogRow[] = (tables.data ?? []).map((table) => ({
      key: `${table.schemaName}.${table.tableName}`,
      name: `${table.schemaName}.${table.tableName}`,
      kind: 'table',
      geometry: table.geometryType,
      features: table.estimatedRows,
      projectId: null,
      projectName: registered.has(table.tableName.toLowerCase()) ? '' : '(unregistered)',
      layerId: null,
    }))
    return [...layerRows, ...tableRows]
  }, [projectQueries, tables.data])

  const visible = rows.filter(
    (row) =>
      (!search || row.name.toLowerCase().includes(search.toLowerCase())) &&
      (!kind || row.kind === kind),
  )

  const kinds = [...new Set(rows.map((row) => row.kind))]

  return (
    <div className="page">
      <header className="page__header">
        <h1>Data catalog</h1>
      </header>

      <div className="page__toolbar">
        <input
          type="search"
          aria-label="Search datasets"
          placeholder="Search datasets"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <span className="page__count mono">{visible.length} datasets</span>
      </div>

      {visible.length === 0 ? (
        <p className="page__empty">
          Nothing matches. Import a file or register a PostGIS table from the map workspace.
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Geometry</th>
              <th scope="col" className="num">
                Features
              </th>
              <th scope="col">Project</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.key}>
                <td>
                  {row.layerId ? (
                    <Link to={`/data/${row.layerId}`} className="row-list__name">
                      {row.name}
                    </Link>
                  ) : (
                    row.name
                  )}
                </td>
                <td>{row.kind}</td>
                <td className="mono">{row.geometry}</td>
                <td className="num mono">{row.features?.toLocaleString() ?? '—'}</td>
                <td>{row.projectName}</td>
                <td>
                  {row.projectId ? (
                    <Link className="row-list__action" to={`/projects/${row.projectId}/map`}>
                      map ▸
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
