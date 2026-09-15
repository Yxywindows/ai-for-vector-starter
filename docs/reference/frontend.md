# 前端实现参考

本文按当前 `web/src` 的实现说明入口、状态归属、业务链路、验证文件和限制，供维护代码或定位行为时使用。它描述代码实际做什么；系统设计背景另见[架构学习篇](../learning/01-architecture-overview.md)、[要素流与范围查询](../learning/04-feature-streaming.md)、[样式](../learning/08-styling-and-renderers.md)、[编辑](../learning/09-editing-and-transactions.md)。

## 运行入口与路由边界

[main.tsx](../../web/src/main.tsx) 以 `StrictMode`、一个共享的 `QueryClientProvider` 和 `RouterProvider` 挂载应用。[router.tsx](../../web/src/app/router.tsx) 把平台页面放入 [PlatformShell.tsx](../../web/src/app/PlatformShell.tsx)，地图工作区 `/projects/:projectId/map` 则是平台壳层旁边的同级路由。

| 路径 | 页面职责 | 主要文件 |
|---|---|---|
| `/` | 平台统计、项目卡片、最近数据集 | [DashboardPage.tsx](../../web/src/pages/DashboardPage.tsx) |
| `/projects`、`/projects/:projectId` | 项目列表和项目图层概览 | [ProjectsPage.tsx](../../web/src/pages/ProjectsPage.tsx)、[ProjectOverviewPage.tsx](../../web/src/pages/ProjectOverviewPage.tsx) |
| `/data`、`/data/:layerId/*` | 已注册图层与 PostGIS 表目录、数据集详情 | [DataCatalogPage.tsx](../../web/src/pages/DataCatalogPage.tsx)、[DatasetDetailsPage.tsx](../../web/src/pages/DatasetDetailsPage.tsx) |
| `/tasks` | 任务进度、日志、取消、重试和结果链接 | [TasksPage.tsx](../../web/src/pages/TasksPage.tsx) |
| `/analysis` | 提交空间分析任务并查看本项目近期运行 | [AnalysisPage.tsx](../../web/src/pages/AnalysisPage.tsx) |
| `/exports` | 提交矢量/栅格导出并查看结果 | [ExportsPage.tsx](../../web/src/pages/ExportsPage.tsx) |
| `/projects/:projectId/map` | 全屏地图工作区 | [App.tsx](../../web/src/App.tsx) |

`App` 在路由中通过 `lazy()` 加载，地图引擎留在工作区 chunk；数据集预览 [MapPreview.tsx](../../web/src/map/MapPreview.tsx) 也只在详情页打开 `preview` 标签时加载。添加图层对话框再懒加载 [ImportPreview.tsx](../../web/src/features/import/ImportPreview.tsx)，其草稿地图和 ag-grid 不会随普通平台页初始加载。这个边界有回归测试：[AnalysisPage.test.tsx](../../web/src/pages/AnalysisPage.test.tsx)、[TasksPage.test.tsx](../../web/src/pages/TasksPage.test.tsx)、[ExportsPage.test.tsx](../../web/src/pages/ExportsPage.test.tsx) 均断言页面不加载地图引擎。

## 状态由谁持有

| 状态/对象 | 所有者 | 代码中的用途 |
|---|---|---|
| 当前项目 | React Router 参数 `projectId` | 查询项目、调用项目变更 API、为工作区存储键加项目范围；不是 Zustand 的权威来源。 |
| 服务端返回的数据 | TanStack Query | `['projects']`、`['project', projectId]`、`['layer', layerId]`、`['fields', layerId]`、`['attributes', ...]`、`['tasks', ...]` 等缓存结果；查询默认值见 [queryClient.ts](../../web/src/app/queryClient.ts)。 |
| 选中图层/要素、截断提示 | Zustand [layerStore.ts](../../web/src/state/layerStore.ts) | 被图层树、属性表、识别弹窗、URL 同步和地图选择样式读取；图层详情仍由 Query 提供。 |
| 面板、对话框、分页/排序、样式草稿、导入草稿、编辑队列 | 各 React 组件或 hook | 生命周期限于对应页面/面板；导入草稿未确认前不写服务端。 |
| 地图视图、OL 图层、矢量要素、瓦片 | OpenLayers 实例 | 由 [MapProvider.tsx](../../web/src/map/MapProvider.tsx)、[MapCanvas.tsx](../../web/src/map/MapCanvas.tsx) 和 [syncLayers.ts](../../web/src/map/syncLayers.ts) 管理；不是 Query/Zustand 数据副本。 |
| 面板布局、底图选项、最近项目 | 浏览器 `localStorage` | 布局与底图按项目保存，平台导航保存最近打开的项目。 |
| 地理响应持久缓存 | [geoCache.ts](../../web/src/cache/geoCache.ts) + [idb.ts](../../web/src/cache/idb.ts) | 是独立模块；当前工作区请求链没有调用它，不能据此推断地图已具备离线缓存。 |

Query 的常用读写集中在 [api](../../web/src/api/client.ts) 与各页面/hook；服务端变更成功后通常让页面失效对应 query key，而不是在 Zustand 维护第二份图层清单。`apiFetch` 统一使用 `/api/v1`、解析错误 envelope、将非 JSON 成功响应视为 `bad_response`，并把 HTTP 204 转成 `undefined`，见 [client.ts](../../web/src/api/client.ts)。

## 工作区状态与持久化

工作区首次挂载时，[App.tsx](../../web/src/App.tsx) 读取并校验 `view=z/lon/lat` 和 `sel=layerId:featureId,...`，解析函数由 [WorkspaceSync.tsx](../../web/src/map/WorkspaceSync.tsx) 导出。之后 `WorkspaceSync` 组件监听地图移动和 Zustand 选择变化，并用 `replace` 更新/删除这些参数。`drawer=1` 在工作区首次初始化时打开属性抽屉，抽屉开关之后也更新该参数。`view` 的缩放范围是 0–28，经纬度范围是经度 ±180、纬度 ±90；格式解析测试在 [WorkspaceSync.test.ts](../../web/src/map/WorkspaceSync.test.ts)。

[App.tsx](../../web/src/App.tsx) 只在首次挂载时读取 URL 初值：之后 URL 由工作区写出，并不会持续反向驱动地图或 store。项目返回的 `view` 是 URL 没有 `view` 时的初始备用值；移动相机时，前端写 URL 和缩略图，不调用导出的 `updateProject()` 回写项目视图。缩略图在首次渲染或移动后延迟 3 秒合成，再以 `PUT /projects/:projectId/thumbnail` 上传。

浏览器存储键由 [workspaceLayout.ts](../../web/src/app/workspaceLayout.ts)、[themes.ts](../../web/src/map/basemaps/themes.ts) 和 [PlatformShell.tsx](../../web/src/app/PlatformShell.tsx) 定义：

- `graticule:layout:${projectId}`：面板开关、停靠/浮动位置和尺寸。
- `graticule:layout-presets:${projectId}`、`graticule:layout-presets:global`：项目及全局布局预设。
- `graticule:basemap:${projectId}`：项目的 Mapbox 主题选择。
- `graticule:lastProject`：平台顶栏“打开地图工作区”的目标。

目前有一个切项目时需要留意的生命周期边界：工作区路由复用同一个 `App`，而 `layout`、初始 URL、OpenLayers `Map` 和 Zustand 选择均没有按 `projectId` 重新挂载/重置；`setProjectId()` 只更新 store 字段。底图选择有显式的项目切换重读逻辑，但上述状态没有同样的逻辑。当前测试验证各纯函数/组件行为，没有覆盖从一个工作区原地切换项目后的整体状态隔离。

## 地图图层如何加载

项目 Query 提供图层数组；[MapCanvas.tsx](../../web/src/map/MapCanvas.tsx) 将地图绑定到 DOM 并调用 `syncLayers()`。`syncLayers` 以 `tier + source` 作为 source fingerprint：新增或 source/tier 改变时才重建 OL 图层，其他更新原地同步可见性、透明度、顺序和样式，尽量保留已加载的 source 内容。

[loadingTiers.ts](../../web/src/map/loadingTiers.ts) 用 PostGIS 图层的 `featureCount` 选择数据路径，阈值为 2,000 和 50,000：

| PostGIS 层级 | 实际请求/渲染 | 编辑能力 |
|---|---|---|
| `small`：≤ 2,000 | [featureLoader.ts](../../web/src/map/featureLoader.ts) 一次读取世界范围 GeoJSON，`limit=2000`，不简化。 | 可编辑 |
| `medium`：2,001–50,000，或数量未知 | OpenLayers 按视口 bbox 请求 GeoJSON；新 bbox 会中止上一请求。按当前分辨率请求拓扑保留简化，城市级分辨率低于阈值时不简化；服务端返回的 `truncated` 进入 store 并由图层面板提示。 | 可编辑 |
| `large`：> 50,000 | [layerFactory.ts](../../web/src/map/layerFactory.ts) 使用应用 MVT 瓦片 URL；客户端只保留当前瓦片而不是整层 GeoJSON。 | 不可编辑 |

其他来源由 `layerFactory` 按 source type 分支：`raster_file` 使用应用 PNG 瓦片、`mvt` 使用向量瓦片、`xyz` 使用远程 XYZ。未知数量的 PostGIS 层走 medium 路径。图层创建、层级阈值及属性同步测试见 [layerFactory.test.ts](../../web/src/map/layerFactory.test.ts)、[featureLoader.test.ts](../../web/src/map/featureLoader.test.ts)、[syncLayers.test.ts](../../web/src/map/syncLayers.test.ts)。

底图主题由 [BasemapSelector.tsx](../../web/src/map/basemaps/BasemapSelector.tsx) 与 [mapboxLayer.ts](../../web/src/map/basemaps/mapboxLayer.ts) 管理：Mapbox token 只从 `VITE_MAPBOX_ACCESS_TOKEN` 读取；切换主题时在数据层下方替换一个 XYZ 瓦片层，并暂时隐藏/恢复项目 basemap 层。无 token 时选项禁用，连续瓦片失败会回退到项目底图。Mapbox 层由这条单独的 `mapboxLayer` 路径创建。

点击识别由 [IdentifyPopup.tsx](../../web/src/map/IdentifyPopup.tsx) 处理：顶层 vector/vector-tile 命中会选择图层及要素并让属性抽屉打开；属性行选择也会更新同一个 Zustand 要素选择。`SelectionSync` 通过 [selection.ts](../../web/src/map/selection.ts) 将选择属性写回普通 `VectorLayer` 的要素。

## 图层导入：立即上传和草稿确认

[AddLayerDialog.tsx](../../web/src/features/layers/AddLayerDialog.tsx) 提供文件与 PostGIS 表两条入口。PostGIS 表来自 `/connections/postgis/tables`，没有主键的表按钮禁用。文件是否进入预览由服务端 `/system/import-limits` 返回的扩展名决定（查询失败前端使用 `.json`、`.geojson` 作为默认值）：其他文件走即时上传。常规导入路由由 [useLayerMutations.ts](../../web/src/features/layers/useLayerMutations.ts) 按文件名后缀选 raster 上传或 vector 上传；草稿确认使用 [api/imports.ts](../../web/src/api/imports.ts) 的独立端点。

预览链路如下：

1. [ImportPreview.tsx](../../web/src/features/import/ImportPreview.tsx) 先取得大小/预览限制，超限时不读取文件；随后 `File.text()` 读取 JSON 文本，并通过 [useParseWorker.ts](../../web/src/features/import/useParseWorker.ts) 交给 Worker。Worker 无法建立、报错或超时会使用同一 [parseGeoJson.ts](../../web/src/features/import/parseGeoJson.ts) 在主线程解析。
2. 解析器接受 FeatureCollection、单 Feature、对象数组以及包含 records/features/data/items/rows 等对象数组的 wrapper；平面记录可从常见经纬度字段推导 Point。属性键、嵌套值和显式 null 保留，异构列会提示并按文本处理。
3. [useImportDraft.ts](../../web/src/features/import/useImportDraft.ts) 在组件内保存命令式 undo/redo 草稿；[DraftGrid.tsx](../../web/src/features/import/DraftGrid.tsx) 编辑属性，[PreviewMap.tsx](../../web/src/features/import/PreviewMap.tsx) 用独立 OL Map 预览。地图只渲染最多 `previewMaxFeatures` 个有几何的要素，表格/导入草稿仍保留全部要素。
4. [validation.ts](../../web/src/features/import/validation.ts) 在浏览器提示几何、坐标及单元格问题；存在阻塞错误或平面记录没有坐标列时禁用确认。服务端仍会重新验证。只有点击 Confirm Import 才调用 `confirmImportDraft`；成功后失效对应项目 Query，取消只丢弃本地草稿。

预览解析器处理的是文本 JSON/GeoJSON，不是 Shapefile、GeoPackage 或栅格的浏览器解析器；这些文件通过普通上传 API 导入。当前读取路径先把完整文件读成字符串，并非流式解析。导入行为覆盖在 [AddLayerDialog.test.tsx](../../web/src/features/layers/AddLayerDialog.test.tsx)、[parseGeoJson.test.ts](../../web/src/features/import/parseGeoJson.test.ts)、[ImportPreview.test.tsx](../../web/src/features/import/ImportPreview.test.tsx)、[useImportDraft.test.ts](../../web/src/features/import/useImportDraft.test.ts)、[validation.test.ts](../../web/src/features/import/validation.test.ts) 等文件中。

## 属性表、几何编辑与样式

**已入库属性表**由 [AttributeTable.tsx](../../web/src/features/attributes/AttributeTable.tsx) 和 [useAttributes.ts](../../web/src/features/attributes/useAttributes.ts) 负责。字段元数据决定单元格是否可编辑；表格每页 50 行，点表头切换排序，双击可编辑单元格后按 PostgreSQL 类型转换，并立刻对单个要素发 PATCH。删除行也是直接 API 请求；表格行选择进入 Zustand。hook 暴露 filters/query 参数，但当前 `AttributeTable` 没有筛选控件，也没有调用 `setFilters()`。值转换测试见 [coerce.test.ts](../../web/src/features/attributes/coerce.test.ts)，界面及 API 行为见 [AttributeTable.test.tsx](../../web/src/features/attributes/AttributeTable.test.tsx)。

**地图几何编辑**由 [EditToolbar.tsx](../../web/src/features/editing/EditToolbar.tsx)、[useEditSession.ts](../../web/src/features/editing/useEditSession.ts) 和 [editSession.ts](../../web/src/features/editing/editSession.ts) 负责。仅 PostGIS 的 small/medium 图层允许 Draw、Modify、Delete；交互期间变化先进入每图层独立的 `EditQueue`，Save 时逐项调用 create/patch/delete，Discard 清空队列并刷新 source。重复修改会折叠；失败操作保留在待处理队列中。它是客户端缓冲，不是跨多条 API 请求的整体事务。几何类型映射、队列与工具栏测试分别在 [editSession.test.ts](../../web/src/features/editing/editSession.test.ts)、[EditToolbar.test.tsx](../../web/src/features/editing/EditToolbar.test.tsx)。

**样式**由 [StyleEditor.tsx](../../web/src/features/styling/StyleEditor.tsx) 编辑本地 draft，点击 Apply 后经图层变更 mutation 保存；地图端 [styleCompiler.ts](../../web/src/map/styleCompiler.ts) 将矢量 StyleSpec 编译为 OpenLayers 样式，栅格样式由服务端瓦片链路解释。矢量分类基于最多 500 行样本；类别上限 50，graduated 分类固定为 5 个 equal-interval classes。栅格编辑器当前提供 colormap 与 rescale 范围（可用 band 统计的 2/98 百分位），没有完整的多波段控制面板。验证见 [StyleEditor.test.tsx](../../web/src/features/styling/StyleEditor.test.tsx)、[defaults.test.ts](../../web/src/features/styling/defaults.test.ts)、[ramps.test.ts](../../web/src/features/styling/ramps.test.ts)、[styleCompiler.test.ts](../../web/src/map/styleCompiler.test.ts)。

## 浏览器内存与地理缓存：两个不同模块

地图工作区通过 [LayerMemoryManager.ts](../../web/src/map/memory/LayerMemoryManager.ts) 做每层数据量估算，默认预算 128 MiB；选中层被 pin，超过预算时按 LRU 清除未 pin 图层的 OL source，防止同一数据过大时反复清空。[useLayerMemory.ts](../../web/src/map/memory/useLayerMemory.ts) 每 2 秒执行预算检查，[MemoryPanel.tsx](../../web/src/features/memory/MemoryPanel.tsx) 同时显示浏览器估算值和每 5 秒查询的服务端内存指标。当前能观察的载荷包括 GeoJSON 字符串长度、应用栅格及通过 layerFactory 创建的外部 XYZ 瓦片 blob 字节和 MVT buffer 字节；独立的 Mapbox 底图路径没有接入这套 manager。这不是浏览器实际解码后 heap 的精确测量。`syncLayers` 删除或重建图层时没有调用 manager 的 `unregister/reset`，因此 accounting 在这些路径上可能保留旧计数；离开工作区卸载时 `App` 会 `clearAll()`。管理器、面板和实际接线见 [LayerMemoryManager.test.ts](../../web/src/map/memory/LayerMemoryManager.test.ts)、[MemoryPanel.test.tsx](../../web/src/features/memory/MemoryPanel.test.tsx)、[layerFactory.ts](../../web/src/map/layerFactory.ts)。

[geoCache.ts](../../web/src/cache/geoCache.ts) 是另一套独立的响应缓存基础设施：模块实现了内存 LRU（32 MiB）、IndexedDB（tiles/features 各自有 256 MiB 上限，超限后各自尝试回收到 224 MiB）、60 秒新鲜期后的 stale-while-revalidate、ETag、并发请求合并、取消和按图层失效；[keys.ts](../../web/src/cache/keys.ts) 的 key 需要 `updatedAt`。但当前 `cachedTile`、`cachedFeatures`、`warmTile` 和 key builder 没有被非测试代码调用；实时 `featureLoader` 走普通 `getFeatures`/`apiFetch`，瓦片交给 OpenLayers 的直接 URL 加载。[api/types.ts](../../web/src/api/types.ts) 的 `Layer` 类型也没有 `updatedAt` 字段。因此这套模块有单元测试，不等于当前地图链路已启用 IndexedDB、ETag 缓存或离线行为。缓存测试集中在 [geoCache.test.ts](../../web/src/cache/geoCache.test.ts) 和 [idb.test.ts](../../web/src/cache/idb.test.ts)。

## 页面业务到代码与测试

| 业务路径 | 实现入口 | 主要验证 |
|---|---|---|
| 平台概览、数据目录、数据集详情 | [DashboardPage.tsx](../../web/src/pages/DashboardPage.tsx)、[DataCatalogPage.tsx](../../web/src/pages/DataCatalogPage.tsx)、[DatasetDetailsPage.tsx](../../web/src/pages/DatasetDetailsPage.tsx) | [DashboardPage.test.tsx](../../web/src/pages/DashboardPage.test.tsx)、[DataCatalogPage.test.tsx](../../web/src/pages/DataCatalogPage.test.tsx) |
| 图层添加、可见性/透明度、层级顺序 | [LayerPanel.tsx](../../web/src/features/layers/LayerPanel.tsx)、[useLayerMutations.ts](../../web/src/features/layers/useLayerMutations.ts) | [LayerPanel.test.tsx](../../web/src/features/layers/LayerPanel.test.tsx)、[reorder.test.ts](../../web/src/features/layers/reorder.test.ts) |
| 导入解析、预览、校验、确认 | [AddLayerDialog.tsx](../../web/src/features/layers/AddLayerDialog.tsx)、[ImportPreview.tsx](../../web/src/features/import/ImportPreview.tsx) | 上文导入段列出的 parser、draft、validation、dialog 和 preview tests |
| 属性查阅与修改 | [AttributeTable.tsx](../../web/src/features/attributes/AttributeTable.tsx)、[useAttributes.ts](../../web/src/features/attributes/useAttributes.ts) | [AttributeTable.test.tsx](../../web/src/features/attributes/AttributeTable.test.tsx)、[coerce.test.ts](../../web/src/features/attributes/coerce.test.ts) |
| 地图绘制、修改、删除 | [EditToolbar.tsx](../../web/src/features/editing/EditToolbar.tsx)、[useEditSession.ts](../../web/src/features/editing/useEditSession.ts) | [EditToolbar.test.tsx](../../web/src/features/editing/EditToolbar.test.tsx)、[editSession.test.ts](../../web/src/features/editing/editSession.test.ts) |
| 分析、导出及后台任务 | [AnalysisPage.tsx](../../web/src/pages/AnalysisPage.tsx)、[ExportsPage.tsx](../../web/src/pages/ExportsPage.tsx)、[TasksPage.tsx](../../web/src/pages/TasksPage.tsx) | 对应同名 `*.test.tsx`；覆盖任务提交/刷新、取消重试、日志、下载链接和不加载地图引擎 |
| 地图构建、请求层级、协调复用 | [layerFactory.ts](../../web/src/map/layerFactory.ts)、[featureLoader.ts](../../web/src/map/featureLoader.ts)、[syncLayers.ts](../../web/src/map/syncLayers.ts) | [layerFactory.test.ts](../../web/src/map/layerFactory.test.ts)、[featureLoader.test.ts](../../web/src/map/featureLoader.test.ts)、[syncLayers.test.ts](../../web/src/map/syncLayers.test.ts) |
| 布局、URL 相机/选择、浏览器缓存 | [workspaceLayout.ts](../../web/src/app/workspaceLayout.ts)、[WorkspaceSync.tsx](../../web/src/map/WorkspaceSync.tsx)、[geoCache.ts](../../web/src/cache/geoCache.ts) | [workspaceLayout.test.ts](../../web/src/app/workspaceLayout.test.ts)、[WorkspaceSync.test.ts](../../web/src/map/WorkspaceSync.test.ts)、缓存模块自身 tests；缓存未接入实时地图见上文 |

## 前端验证命令

从 `web/` 执行；脚本定义在 [package.json](../../web/package.json)，Vitest 使用 jsdom 与 [vitest.setup.ts](../../web/vitest.setup.ts)：

```bash
npm run lint
npm run typecheck
npm run test -- --run
npm run build
```

`npm run build` 会先执行 TypeScript project build 再运行 Vite 生产构建。性能脚本是 `npm run bench`，说明见 [bench/README.md](../../web/bench/README.md)。

## 当前实现边界速查

- 项目列表/概览提供浏览和地图入口；[ProjectsPage.tsx](../../web/src/pages/ProjectsPage.tsx) 没有创建项目表单，空状态也提示通过 API 创建。`createProject()` 目前是 API helper。
- 数据集详情的 `versions`、`permissions`、`results` 标签中，版本管理、访问控制和分析结果关联仍是占位说明，见 [DatasetDetailsPage.tsx](../../web/src/pages/DatasetDetailsPage.tsx)。
- 属性表 hook 有过滤参数，但表格 UI 当前没有过滤器；几何编辑与属性单元格保存是两条不同链路。
- large PostGIS MVT、栅格、外部 MVT/XYZ 不支持当前地图几何编辑；编辑工具只针对 PostGIS small/medium source。
- 地图相机没有通过前端 API 保存到项目 `view` 字段；URL 查询参数是会话分享/恢复入口，但只在工作区初次挂载时读取。
- `geoCache` 有实现与测试，但 live map 不调用；浏览器内存统计只是若干载荷估算，不代表总 heap，也不覆盖所有图层源。
- 当前源码级测试没有覆盖“工作区原地切换项目时重置全局地图/选择/布局状态”的集成行为；如修改路由生命周期或状态作用域，应增加对应回归测试。
