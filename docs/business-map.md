# 业务功能与代码管理关系

[目录](README.md) · [代码地图](ai/code-map.md) · [接口明细](reference/api.md)

每个 B 编号是一组稳定的业务职责。改动时沿同行读取入口、服务和测试，再检查后面的跨功能影响。表内文件链接是可执行实现或测试证据；不表示本次重新运行了相应测试。

## 端到端映射

| ID / 功能 | 用户入口 / 前端调用 | 后端入口与实现 | 数据结果 | 主要测试 |
|---|---|---|---|---|
| B01 项目与视图 | [ProjectsPage](../web/src/pages/ProjectsPage.tsx)、[WorkspaceSync](../web/src/map/WorkspaceSync.tsx)、[layers API](../web/src/api/layers.ts) | [projects 路由](../backend/app/api/v1/routes/projects.py) → [project_service](../backend/app/services/project_service.py) | Project、Layer 顺序、view；缩略图文件 | [projects API](../backend/tests/test_projects_api.py)、[WorkspaceSync](../web/src/map/WorkspaceSync.test.ts) |
| B02 概览与数据目录 | [DashboardPage](../web/src/pages/DashboardPage.tsx)、[DataCatalogPage](../web/src/pages/DataCatalogPage.tsx)、[DatasetDetailsPage](../web/src/pages/DatasetDetailsPage.tsx) | [catalog](../backend/app/api/v1/routes/catalog.py)、[system](../backend/app/api/v1/routes/system.py) → [catalog_service](../backend/app/services/catalog_service.py)、[system_service](../backend/app/services/system_service.py) | 跨项目 Layer 检索、PostGIS 表目录、统计 | [catalog API](../backend/tests/test_catalog_api.py)、[system API](../backend/tests/test_system_api.py)、[DataCatalogPage](../web/src/pages/DataCatalogPage.test.tsx) |
| B03 图层管理 | [LayerPanel](../web/src/features/layers/LayerPanel.tsx)、[useLayerMutations](../web/src/features/layers/useLayerMutations.ts) | [layers](../backend/app/api/v1/routes/layers.py)、projects → [layer_service](../backend/app/services/layer_service.py) | Layer 名称、source、style、visible、opacity、z_index | [layers API](../backend/tests/test_layers_api.py)、[LayerPanel](../web/src/features/layers/LayerPanel.test.tsx) |
| B04 数据导入 | [AddLayerDialog](../web/src/features/layers/AddLayerDialog.tsx)、[ImportPreview](../web/src/features/import/ImportPreview.tsx)、[imports API](../web/src/api/imports.ts) | [imports](../backend/app/api/v1/routes/imports.py) → [draft](../backend/app/services/draft_import_service.py)、[vector](../backend/app/services/vector_import_service.py)、[raster](../backend/app/services/raster_import_service.py) | 空间表或 COG + Layer；草稿返回 errors/warnings | [draft](../backend/tests/test_import_draft.py)、[vector](../backend/tests/test_vector_import.py)、[raster](../backend/tests/test_raster_import.py)、[draft UI](../web/src/features/import/useImportDraft.test.ts) |
| B05 地图与瓦片 | [MapCanvas](../web/src/map/MapCanvas.tsx)、[layerFactory](../web/src/map/layerFactory.ts)、[featureLoader](../web/src/map/featureLoader.ts) | [features](../backend/app/api/v1/routes/features.py)、[tiles](../backend/app/api/v1/routes/tiles.py) → [feature_service](../backend/app/services/feature_service.py)、[tile_service](../backend/app/services/tile_service.py)、[raster_tile_service](../backend/app/services/raster_tile_service.py) | GeoJSON、MVT、PNG；地图显示、截断提示 | [feature API](../backend/tests/test_features_api.py)、[MVT](../backend/tests/test_vector_tiles_api.py)、[raster tiles](../backend/tests/test_raster_tiles_api.py)、[layerFactory](../web/src/map/layerFactory.test.ts) |
| B06 属性与几何编辑 | [AttributeTable](../web/src/features/attributes/AttributeTable.tsx)、[useEditSession](../web/src/features/editing/useEditSession.ts) | features → [attribute_service](../backend/app/services/attribute_service.py)、[edit_service](../backend/app/services/edit_service.py) | 分页行、字段、单要素写入；EditQueue 可部分成功 | [attributes](../backend/tests/test_attributes_api.py)、[editing](../backend/tests/test_editing_api.py)、[editSession](../web/src/features/editing/editSession.test.ts) |
| B07 样式与底图 | [StyleEditor](../web/src/features/styling/StyleEditor.tsx)、[styleCompiler](../web/src/map/styleCompiler.ts)、[BasemapSelector](../web/src/map/basemaps/BasemapSelector.tsx) | layers PATCH → [style schema](../backend/app/schemas/style.py)；栅格显示还依赖 raster_tile_service | Layer.style 与浏览器渲染；底图主题 | [StyleEditor](../web/src/features/styling/StyleEditor.test.tsx)、[styleCompiler](../web/src/map/styleCompiler.test.ts)、[basemaps](../web/src/map/basemaps/themes.test.ts) |
| B08 后台任务 | [TasksPage](../web/src/pages/TasksPage.tsx)、[tasks API](../web/src/api/tasks.ts) | [tasks](../backend/app/api/v1/routes/tasks.py) → [task_service](../backend/app/services/task_service.py) → [worker](../backend/app/services/task_worker.py) / [handlers](../backend/app/services/task_handlers.py) | Task 状态、日志、结果、取消标记与 retry_of | [tasks](../backend/tests/test_tasks.py)、[TasksPage](../web/src/pages/TasksPage.test.tsx) |
| B09 空间分析 | [AnalysisPage](../web/src/pages/AnalysisPage.tsx)、[analysis API](../web/src/api/analysis.ts) | [analysis 路由](../backend/app/api/v1/routes/analysis.py) → Task → [analysis_service](../backend/app/services/analysis_service.py) | 新空间表、索引、Layer、任务结果 | [analysis](../backend/tests/test_analysis.py)、[AnalysisPage](../web/src/pages/AnalysisPage.test.tsx) |
| B10 导出与下载 | [ExportsPage](../web/src/pages/ExportsPage.tsx)、[exports API](../web/src/api/exports.ts) | [exports 路由](../backend/app/api/v1/routes/exports.py) → Task → [export_service](../backend/app/services/export_service.py) | exports 文件；download 返回文件并记录下载时间 | [exports](../backend/tests/test_exports.py)、[ExportsPage](../web/src/pages/ExportsPage.test.tsx) |
| B11 资源与内存 | [MemoryPanel](../web/src/features/memory/MemoryPanel.tsx)、[LayerMemoryManager](../web/src/map/memory/LayerMemoryManager.ts) | system/memory → [system_service](../backend/app/services/system_service.py)、[DatasetPool](../backend/app/resources/dataset_pool.py) | 句柄、RSS、地图估算字节与逐出 | [pool](../backend/tests/test_dataset_pool.py)、[memory manager](../web/src/map/memory/LayerMemoryManager.test.ts) |
| B12 工作区布局 | [AppShell](../web/src/app/AppShell.tsx)、[LayoutMenu](../web/src/app/LayoutMenu.tsx)、[workspaceLayout](../web/src/app/workspaceLayout.ts) | 浏览器本地布局持久化，无独立后端布局 API | 项目布局与命名预设 | [workspaceLayout](../web/src/app/workspaceLayout.test.ts)、[LayoutMenu](../web/src/app/LayoutMenu.test.tsx) |

## 管理关系

Project 拥有图层与任务；Layer.source 指向真实数据；Task 可以引用输入或输出 Layer。B04、B09 的结果进入 B03/B05/B06；B10 消费已有图层。B08 是执行记录与调度底座，不是独立的数据副本。

七个分析工具由 [analysis.py 契约](../backend/app/schemas/analysis.py)和 [analysis_service](../backend/app/services/analysis_service.py)定义：buffer、clip、intersection、dissolve、spatial-join、validate-repair、point-in-polygon。前端表单不是唯一验证边界，handler 会再次验证输入层与字段。

## 改动影响范围

| 改动 | 需要共同检查 |
|---|---|
| source 或字段命名 | B02 注册来源、B04 导入、B05 查询/瓦片、B06 编辑、B09/B10 SQL |
| Layer 契约或版本 | B03 PATCH、B05 同步/HTTP 缓存、B07 样式；前后端类型与测试 |
| 导入限制 | B04 Worker/预览/服务器配置；B08 文件上传任务路径有不同限制 |
| Task 状态或结果结构 | B08 状态机、worker、重试；B09/B10 页面结果导航与下载 |
| 删除语义 | B01/B03 元数据级联、B08 历史、B04/B09 空间表、B10 文件；当前没有通用实体清理 |
| 加载阈值 | B05 数量分级、服务器上限、B06 大图层编辑禁用、B11 内存 |
| 编辑写路径 | B06 事务/局部成功、B05 缓存与统计刷新；当前 Layer 版本不会随实体行写入自动推进 |

新增功能时复用所属业务域的入口、契约和测试位置。先明确事务、来源验证和结果消费方，再决定是否需要新模块。

