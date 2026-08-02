import { useQuery } from '@tanstack/react-query'
import { Suspense, lazy, useState } from 'react'

import { listPostgisTables } from '../../api/catalog'
import { getImportLimits } from '../../api/imports'
import { useLayerMutations } from './useLayerMutations'

// The staged-import workspace drags ag-grid and a second map along with
// it; neither belongs in this dialog's chunk until a file is actually
// staged.
const ImportPreview = lazy(() =>
  import('../import/ImportPreview').then((module) => ({ default: module.ImportPreview })),
)

interface AddLayerDialogProps {
  projectId: string
  open: boolean
  onClose: () => void
}

export function AddLayerDialog({ projectId, open, onClose }: AddLayerDialogProps) {
  const mutations = useLayerMutations(projectId)
  const [tab, setTab] = useState<'file' | 'postgis'>('file')
  const [staged, setStaged] = useState<File | null>(null)
  const limits = useQuery({ queryKey: ['import-limits'], queryFn: getImportLimits })
  const tables = useQuery({
    queryKey: ['postgis-tables'],
    queryFn: listPostgisTables,
    enabled: open && tab === 'postgis',
  })

  if (!open) return null

  return (
    <div className="dialog" role="dialog" aria-label="Add layer">
      <h2 className="dialog__title">Add layer</h2>
      <div className="dialog__tabs">
        <button type="button" onClick={() => setTab('file')} aria-pressed={tab === 'file'}>
          Upload file
        </button>
        <button type="button" onClick={() => setTab('postgis')} aria-pressed={tab === 'postgis'}>
          PostGIS table
        </button>
      </div>

      {tab === 'file' ? (
        <label className="dialog__field">
          GeoJSON, GeoPackage, zipped Shapefile or GeoTIFF
          <input
            type="file"
            accept=".geojson,.json,.gpkg,.zip,.shp,.tif,.tiff"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              // A staged format opens the preview; nothing is imported until
              // the user confirms there. Every other format keeps the existing
              // immediate path -- they have no preview implementation.
              const extensions = limits.data?.allowedExtensions ?? ['.json', '.geojson']
              const staging = extensions.some((extension) =>
                file.name.toLowerCase().endsWith(extension),
              )
              if (staging) setStaged(file)
              else mutations.importFile.mutate({ file }, { onSuccess: onClose })
            }}
          />
        </label>
      ) : (
        <ul className="dialog__tables">
          {tables.isLoading ? <li>Loading…</li> : null}
          {tables.data?.map((table) => (
            <li key={`${table.schemaName}.${table.tableName}`}>
              <button
                type="button"
                disabled={!table.primaryKey}
                title={table.primaryKey ? undefined : 'Table has no primary key'}
                onClick={() =>
                  mutations.addPostgisTable.mutate(
                    {
                      schemaName: table.schemaName,
                      tableName: table.tableName,
                      geometryColumn: table.geometryColumn,
                      idColumn: table.primaryKey ?? 'id',
                      name: table.tableName,
                    },
                    { onSuccess: onClose },
                  )
                }
              >
                {table.schemaName}.{table.tableName} · {table.geometryType} · ~
                {table.estimatedRows} rows
              </button>
            </li>
          ))}
        </ul>
      )}

      {mutations.importFile.isError ? (
        <p role="alert">{(mutations.importFile.error as Error).message}</p>
      ) : null}

      <button type="button" onClick={onClose}>
        Close
      </button>

      {staged ? (
        <Suspense fallback={null}>
          <ImportPreview
            projectId={projectId}
            file={staged}
            onClose={() => {
              setStaged(null)
              onClose()
            }}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
