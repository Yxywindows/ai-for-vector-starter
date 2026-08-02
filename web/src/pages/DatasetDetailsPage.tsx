import { useQuery } from '@tanstack/react-query'
import { Suspense, lazy } from 'react'
import { Link, NavLink, useParams } from 'react-router'

import { getFields } from '../api/features'
import { getLayer } from '../api/layers'
import type { Layer } from '../api/types'
import { StyleEditor } from '../features/styling/StyleEditor'
import { ExtentSketch } from './ExtentSketch'

// The one tab allowed to cost a map engine — loaded only when opened.
const MapPreview = lazy(() => import('../map/MapPreview'))

const TABS = [
  'overview',
  'metadata',
  'schema',
  'extent',
  'preview',
  'style',
  'versions',
  'permissions',
  'results',
] as const

type Tab = (typeof TABS)[number]

function SchemaTab({ layer }: { layer: Layer }) {
  const fields = useQuery({
    queryKey: ['fields', layer.id],
    queryFn: () => getFields(layer.id),
    enabled: layer.source.type === 'postgis',
  })
  if (layer.source.type !== 'postgis') {
    return <p className="page__empty">This dataset kind has no attribute schema.</p>
  }
  if (fields.isLoading) return <p className="page__empty">Loading schema…</p>
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">Column</th>
          <th scope="col">Type</th>
          <th scope="col">Nullable</th>
          <th scope="col">Editable</th>
        </tr>
      </thead>
      <tbody>
        {fields.data?.fields.map((field) => (
          <tr key={field.name}>
            <td className="mono">{field.name}</td>
            <td className="mono">{field.dataType}</td>
            <td>{field.nullable ? 'yes' : 'no'}</td>
            <td>{field.editable ? 'yes' : 'no'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function OverviewTab({ layer }: { layer: Layer }) {
  return (
    <section className="dataset-overview">
      <ExtentSketch extent={layer.extent} />
      <dl className="kv">
        <div>
          <dt>Kind</dt>
          <dd>{layer.kind}</dd>
        </div>
        <div>
          <dt>Geometry</dt>
          <dd className="mono">{layer.geometryType ?? '—'}</dd>
        </div>
        <div>
          <dt>Features</dt>
          <dd className="mono">{layer.featureCount?.toLocaleString() ?? '—'}</dd>
        </div>
        <div>
          <dt>SRID</dt>
          <dd className="mono">{layer.srid ?? '—'}</dd>
        </div>
        <div>
          <dt>Visible</dt>
          <dd>{layer.visible ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt>Source file</dt>
          <dd className="mono">{layer.sourceFilename ?? '—'}</dd>
        </div>
      </dl>
    </section>
  )
}

function MetadataTab({ layer }: { layer: Layer }) {
  return (
    <dl className="kv kv--wide">
      <div>
        <dt>Layer id</dt>
        <dd className="mono">{layer.id}</dd>
      </div>
      <div>
        <dt>Project id</dt>
        <dd className="mono">{layer.projectId}</dd>
      </div>
      <div>
        <dt>Source</dt>
        <dd className="mono">{JSON.stringify(layer.source)}</dd>
      </div>
      <div>
        <dt>Opacity</dt>
        <dd className="mono">{layer.opacity}</dd>
      </div>
      <div>
        <dt>Z-index</dt>
        <dd className="mono">{layer.zIndex}</dd>
      </div>
    </dl>
  )
}

function ExtentTab({ layer }: { layer: Layer }) {
  if (!layer.extent) return <p className="page__empty">This dataset records no extent.</p>
  const [minx, miny, maxx, maxy] = layer.extent
  return (
    <section className="dataset-overview">
      <ExtentSketch extent={layer.extent} />
      <dl className="kv">
        <div>
          <dt>West</dt>
          <dd className="mono">{minx.toFixed(6)}°</dd>
        </div>
        <div>
          <dt>South</dt>
          <dd className="mono">{miny.toFixed(6)}°</dd>
        </div>
        <div>
          <dt>East</dt>
          <dd className="mono">{maxx.toFixed(6)}°</dd>
        </div>
        <div>
          <dt>North</dt>
          <dd className="mono">{maxy.toFixed(6)}°</dd>
        </div>
      </dl>
    </section>
  )
}

export function DatasetDetailsPage() {
  const params = useParams<{ layerId: string; '*': string }>()
  const layerId = params.layerId
  const tab: Tab = (TABS as readonly string[]).includes(params['*'] ?? '')
    ? (params['*'] as Tab)
    : 'overview'

  const layer = useQuery({
    queryKey: ['layer', layerId],
    queryFn: () => getLayer(layerId!),
    enabled: Boolean(layerId),
  })

  if (layer.isLoading) return <p className="page__empty">Loading dataset…</p>
  if (!layer.data) return <p className="page__empty">Dataset not found.</p>
  const data = layer.data

  return (
    <div className="page">
      <header className="page__header">
        <h1>{data.name}</h1>
        <Link to={`/projects/${data.projectId}/map`} className="btn-link btn-link--primary">
          Open on map ▸
        </Link>
      </header>

      <nav className="tab-bar" aria-label="Dataset sections">
        {TABS.map((name) => (
          <NavLink
            key={name}
            to={`/data/${layerId}${name === 'overview' ? '' : `/${name}`}`}
            end
            className={() => (tab === name ? 'tab-bar__tab tab-bar__tab--active' : 'tab-bar__tab')}
          >
            {name}
          </NavLink>
        ))}
      </nav>

      {tab === 'overview' ? <OverviewTab layer={data} /> : null}
      {tab === 'metadata' ? <MetadataTab layer={data} /> : null}
      {tab === 'schema' ? <SchemaTab layer={data} /> : null}
      {tab === 'extent' ? <ExtentTab layer={data} /> : null}
      {tab === 'preview' ? (
        <Suspense fallback={<p className="page__empty">Loading preview…</p>}>
          <MapPreview layer={data} />
        </Suspense>
      ) : null}
      {tab === 'style' ? (
        data.kind === 'vector' || data.kind === 'raster' ? (
          <div className="dataset-style">
            <StyleEditor key={data.id} projectId={data.projectId} layer={data} />
          </div>
        ) : (
          <p className="page__empty">This dataset kind has no editable style.</p>
        )
      ) : null}
      {tab === 'versions' ? (
        <dl className="kv">
          <div>
            <dt>Imported from</dt>
            <dd className="mono">{data.sourceFilename ?? 'registered table / external source'}</dd>
          </div>
          <div>
            <dt>Versioning</dt>
            <dd>Single current version — dataset versioning is not yet implemented.</dd>
          </div>
        </dl>
      ) : null}
      {tab === 'permissions' ? (
        <p className="page__empty">
          Local workspace — no access control is configured. This tab defines the boundary where
          authentication integrates later.
        </p>
      ) : null}
      {tab === 'results' ? (
        <p className="page__empty">
          No analysis results reference this dataset yet. Results will land here once spatial
          analysis ships.
        </p>
      ) : null}
    </div>
  )
}
