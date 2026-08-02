export type LayerKind = 'vector' | 'raster' | 'vector_tile' | 'basemap'

export interface PostgisSource {
  type: 'postgis'
  schemaName: string
  tableName: string
  geometryColumn: string
  idColumn: string
  srid: number
}
export interface RasterFileSource {
  type: 'raster_file'
  path: string
  bandCount: number
  nodata: number | null
  isCog: boolean
}
export interface XyzSource {
  type: 'xyz'
  url: string
  attribution: string | null
}
export interface MvtSource {
  type: 'mvt'
  url: string
  sourceLayer: string | null
}
export type LayerSource = PostgisSource | RasterFileSource | XyzSource | MvtSource

export interface FillStyle {
  color: string
  opacity: number
}
export interface StrokeStyle {
  color: string
  width: number
  dash: number[] | null
}
export interface MarkerStyle {
  shape: 'circle' | 'square' | 'triangle'
  radius: number
}
export interface LabelStyle {
  field: string
  color: string
  size: number
  haloColor: string
}
export interface ColorStop {
  color: string
  value: string | number | null
  min: number | null
  max: number | null
  label: string | null
}
export interface SingleRenderer {
  type: 'single'
}
export interface CategorizedRenderer {
  type: 'categorized'
  field: string
  categories: ColorStop[]
  fallbackColor: string
}
export interface GraduatedRenderer {
  type: 'graduated'
  field: string
  method: 'equal_interval' | 'quantile' | 'natural_breaks'
  classes: ColorStop[]
}
export type Renderer = SingleRenderer | CategorizedRenderer | GraduatedRenderer

export interface VectorStyle {
  kind: 'vector'
  renderer: Renderer
  fill: FillStyle
  stroke: StrokeStyle
  marker: MarkerStyle
  label: LabelStyle | null
}
export interface RasterStyle {
  kind: 'raster'
  bands: number[]
  rescale: [number, number][] | null
  colormap: string | null
  opacity: number
}
export type StyleSpec = VectorStyle | RasterStyle

export type Extent = [number, number, number, number]

export interface Layer {
  id: string
  projectId: string
  name: string
  kind: LayerKind
  source: LayerSource
  style: StyleSpec | null
  visible: boolean
  opacity: number
  zIndex: number
  extent: Extent | null
  featureCount: number | null
  srid: number | null
  geometryType: string | null
  sourceFilename?: string | null
}

export interface MapView {
  center: [number, number]
  zoom: number
  projection: string
}
export interface Project {
  id: string
  name: string
  view: MapView
  layers: Layer[]
}
export interface ProjectSummary {
  id: string
  name: string
  layerCount: number
}

export interface GeoFeature {
  type: 'Feature'
  id: string
  geometry: GeoJSON.Geometry | null
  properties: Record<string, unknown>
}
export interface FeatureCollection {
  type: 'FeatureCollection'
  features: GeoFeature[]
  returned: number
  limit: number
  truncated: boolean
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  editable: boolean
}
export interface FieldList {
  fields: ColumnInfo[]
  idColumn: string
  geometryColumn: string
}
export interface AttributeFilter {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'isnull' | 'notnull'
  value?: unknown
}
export interface AttributePage {
  columns: string[]
  rows: Record<string, unknown>[]
  page: number
  pageSize: number
  total: number
}

export interface GeometryTableInfo {
  schemaName: string
  tableName: string
  geometryColumn: string
  srid: number
  geometryType: string
  primaryKey: string | null
  estimatedRows: number
}

export interface PoolStats {
  openHandles: number
  maxOpen: number
  idleTtlSeconds: number
  hits: number
  misses: number
  evictions: number
  keys: string[]
}
export interface MemoryReport {
  rasterPool: PoolStats
  featureBboxLimit: number
  attributePageMax: number
  processRssBytes: number
}
export interface BandStatistics {
  band: number
  min: number
  max: number
  mean: number
  std: number
  percentile2: number
  percentile98: number
}
export interface RasterStatistics {
  bands: BandStatistics[]
}

export interface ImportLimits {
  allowedExtensions: string[]
  maxFileBytes: number
  maxFeatures: number
  previewMaxFeatures: number
}

export interface FeatureIssue {
  featureIndex: number
  field: string | null
  code: string
  message: string
}

export interface ImportResult {
  layer: Layer
  importedCount: number
  rejectedCount: number
  warningCount: number
  errors: FeatureIssue[]
  warnings: FeatureIssue[]
}

export interface OverviewLayer {
  id: string
  name: string
  kind: string
  geometryType: string | null
  featureCount: number | null
  projectId: string
  projectName: string
  createdAt: string
}

export interface SystemOverview {
  projectCount: number
  layerCount: number
  layersByKind: Record<string, number>
  featureTotal: number
  recentLayers: OverviewLayer[]
}

export type TaskState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

export interface TaskError {
  code: string
  message: string
  details?: unknown
}

export interface Task {
  id: string
  projectId: string
  projectName: string | null
  layerId: string | null
  kind: string
  state: TaskState
  progress: number
  stage: string | null
  params: Record<string, unknown>
  result: Record<string, unknown> | null
  error: TaskError | null
  retryOf: string | null
  retryable: boolean
  cancelRequested: boolean
  provenance: Record<string, unknown>
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
  durationMs: number | null
}

export interface TaskPage {
  items: Task[]
  total: number
  page: number
  pageSize: number
}

export interface TaskLogEntry {
  ts: string
  level: string
  message: string
}
