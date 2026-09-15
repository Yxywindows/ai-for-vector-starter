export type FeatureId = 'projects' | 'data' | 'analysis' | 'tasks' | 'exports' | 'overview'

export interface FeatureDefinition {
  id: FeatureId
  label: string
  kicker: string
  summary: string
  dialogue: string
  href: string
  normal: readonly [number, number, number]
}

/** Stable face identities, in exported glTF coordinates (+Y up). No business state here. */
export const FEATURES: readonly FeatureDefinition[] = [
  {
    id: 'projects',
    label: '项目空间',
    kicker: 'PROJECTS',
    href: '/projects',
    normal: [0, 0, 1],
    summary: '从项目出发，组织图层，进入你的地图工作区。',
    dialogue: '先选一个项目，我们再一起探索它的地图和图层。',
  },
  {
    id: 'data',
    label: '数据资源',
    kicker: 'DATA CATALOG',
    href: '/data',
    normal: [1, 0, 0],
    summary: '浏览数据目录，了解来源、字段与空间范围。',
    dialogue: '这里收集了你的空间数据。选择一份数据，就能查看它的详细信息。',
  },
  {
    id: 'analysis',
    label: '空间分析',
    kicker: 'SPATIAL ANALYSIS',
    href: '/analysis',
    normal: [0, 0, -1],
    summary: '选择输入图层，使用空间工具发现数据之间的关系。',
    dialogue: '先选择项目和输入图层，我会帮你准备分析工具。',
  },
  {
    id: 'tasks',
    label: '任务进度',
    kicker: 'MISSION LOG',
    href: '/tasks',
    normal: [-1, 0, 0],
    summary: '跟进任务状态，查看日志、运行结果与重试入口。',
    dialogue: '我们去看看任务的实际进度。需要排查时，日志会提供更多线索。',
  },
  {
    id: 'exports',
    label: '导出交付',
    kicker: 'EXPORTS',
    href: '/exports',
    normal: [0, 1, 0],
    summary: '选择输出格式与范围，将你的空间成果交付出去。',
    dialogue: '准备好要导出的图层了吗？选好格式和范围，再开始导出。',
  },
  {
    id: 'overview',
    label: '平台概览',
    kicker: 'OVERVIEW',
    href: '/overview',
    normal: [0, -1, 0],
    summary: '查看平台统计、最近项目和新加入的数据。',
    dialogue: '先从全局看一眼，最近的项目和数据都在这里。',
  },
]

export function getFeature(id: FeatureId): FeatureDefinition {
  return FEATURES.find((feature) => feature.id === id)!
}

export function featureForPath(pathname: string): FeatureDefinition | null {
  return FEATURES.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`)) ?? null
}

export function isWorkspacePath(pathname: string): boolean {
  return /^\/projects\/[^/]+\/map\/?$/.test(pathname)
}
