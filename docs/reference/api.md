# 后端 API 清单

本清单按当前 FastAPI router 和 schema 编写。默认前缀是 GIS_API_PREFIX=/api/v1；本页中的版本化路径都带此前缀。/health 另外以裸路径注册。本次静态路由清单应包含 49 个方法+路径操作：其中 /health 与 /api/v1/health 分别计一项。实现入口是 [main.py](../../backend/app/main.py)、[v1 router](../../backend/app/api/v1/router.py)，单项接口代码位于 [routes](../../backend/app/api/v1/routes)。

## 通用 wire 规则

- Schema 继承 APIModel：JSON 输出采用 camelCase；输入可使用 camelCase 或 Python snake_case；未声明的额外字段会被拒绝。请求/响应定义见 [schemas/base.py](../../backend/app/schemas/base.py)。
- 业务错误和框架验证错误统一为 {error:{code,message,details}}。错误状态码映射见 [core/errors.py](../../backend/app/core/errors.py)；主要错误码为 not_found=404、conflict=409、invalid_request=422、unsupported_format=415、payload_too_large=413、upstream_data_error=502、service_unavailable=503、internal_error=500。
- 路由没有认证/授权依赖。项目路径只用于定位元数据、任务归属或输出位置，不自动证明图层属于该项目。
- 省略字段是否代表“不变”取决于 schema/service；PATCH 里 null 往往被 service 当作未提供，不能假定 null 会清空字段。

## 健康、项目、图层（15 项含健康检查）

| 方法 | 路径 | 请求与响应 | 实现 / 测试 |
|---|---|---|---|
| GET | /health | 无请求体；返回 status 和 environment。 | [health.py](../../backend/app/api/v1/routes/health.py)、[test_health.py](../../backend/tests/test_health.py) |
| GET | /api/v1/health | 与裸 /health 使用相同 handler。 | 同上 |
| POST | /api/v1/projects | ProjectCreate：name 必填，1–200 字符；view 可省略，默认 center [0,0]、zoom 2、projection EPSG:3857。返回 ProjectRead，201。 | [projects.py](../../backend/app/api/v1/routes/projects.py)、[project.py](../../backend/app/schemas/project.py)、[test_projects_api.py](../../backend/tests/test_projects_api.py) |
| GET | /api/v1/projects | 返回 ProjectSummary 数组：id、name、layerCount。 | 同上 |
| GET | /api/v1/projects/{project_id} | 返回 ProjectRead，包含按 zIndex 排序的 layers。不存在为 404。 | 同上 |
| PATCH | /api/v1/projects/{project_id} | name 和/或 view；省略或 null 会跳过该字段，不提供清空 view 的语义。返回更新后 ProjectRead。 | 同上 |
| DELETE | /api/v1/projects/{project_id} | 无请求体；成功 204。数据库外键会级联删除 project 的 layer/task 元数据；源表、栅格和文件没有在此路由清理。 | [projects.py](../../backend/app/api/v1/routes/projects.py)、[project_service.py](../../backend/app/services/project_service.py)、[test_projects_api.py](../../backend/tests/test_projects_api.py) |
| PUT | /api/v1/projects/{project_id}/thumbnail | 请求 body 是原始 PNG bytes，不是 multipart。仅检查非空且不超过 2 MiB，不校验 PNG 文件签名。成功 204。 | [projects.py](../../backend/app/api/v1/routes/projects.py)、[test_projects_api.py](../../backend/tests/test_projects_api.py) |
| GET | /api/v1/projects/{project_id}/thumbnail | 返回 image/png；尚无缩略图为 404；缓存 300 秒。 | 同上 |
| GET | /api/v1/projects/{project_id}/layers | 返回该项目 LayerRead 数组，zIndex 升序。 | [projects.py](../../backend/app/api/v1/routes/projects.py)、[test_layers_api.py](../../backend/tests/test_layers_api.py) |
| POST | /api/v1/projects/{project_id}/layers | LayerCreate：name、kind、source 必填；style 可省略；visible 默认 true；opacity 默认 1 且范围 0–1。返回 LayerRead，201；项目内重复名称为 409。 | [projects.py](../../backend/app/api/v1/routes/projects.py)、[schemas/layer.py](../../backend/app/schemas/layer.py)、[test_layers_api.py](../../backend/tests/test_layers_api.py) |
| POST | /api/v1/projects/{project_id}/layers/reorder | body {layerIds:[uuid,...]}。必须无重复并且恰好列出项目全部图层；不接受子集。返回新顺序的 LayerRead 数组。 | [projects.py](../../backend/app/api/v1/routes/projects.py)、[test_layers_api.py](../../backend/tests/test_layers_api.py) |
| GET | /api/v1/layers/{layer_id} | 返回 LayerRead。 | [layers.py](../../backend/app/api/v1/routes/layers.py)、[test_layers_api.py](../../backend/tests/test_layers_api.py) |
| PATCH | /api/v1/layers/{layer_id} | 可更新 name/style/visible/opacity；style、name 等 null 会被忽略，没有通过传 null 清除 style 的语义。重复项目内名称为 409。 | 同上 |
| DELETE | /api/v1/layers/{layer_id} | 成功 204。任务的 layer_id 由 SET NULL 保留任务行；没有 DROP 源表或删除 raster 文件的逻辑。 | 同上 |

LayerSource 的 type 可为 postgis、raster_file、xyz、mvt；Layer.kind 可为 vector、raster、vector_tile、basemap。两者独立验证，创建接口不做 kind/source 组合校验。服务端读取能力边界见 [source.py](../../backend/app/schemas/source.py) 与[后端架构地图](backend.md#数据归属与关系)。

## PostGIS 目录与登记（2 项）

| 方法 | 路径 | 请求与响应 | 实现 / 测试 |
|---|---|---|---|
| GET | /api/v1/connections/postgis/tables | 无请求体；列出可见 geometry_columns 表及 schema/table/geometry 列、SRID、geometry type、发现的 primary key 和估算行数；隐藏 PostgreSQL、information_schema、topology、tiger 系统 schema。 | [catalog.py](../../backend/app/api/v1/routes/catalog.py)、[test_catalog_api.py](../../backend/tests/test_catalog_api.py) |
| POST | /api/v1/projects/{project_id}/layers/from-postgis | body：schemaName、tableName、geometryColumn、idColumn、name。schemaName/tableName/geometryColumn/idColumn 限小写字母/数字/下划线，1–63 字符且不能数字开头；显示名称 name 为 1–200 字符。返回 LayerRead，201。SRID 从 geometry_columns 推导，不由 body 传入；表、列、geometry metadata 必须存在，SRID 必须已知。请求的 idColumn 仅校验为存在列，不校验它是否等于 primary key。 | [catalog.py](../../backend/app/api/v1/routes/catalog.py)、[catalog_service.py](../../backend/app/services/catalog_service.py)、[test_catalog_api.py](../../backend/tests/test_catalog_api.py) |

登记过程先建 Layer，再查询 extent/count；同一请求事务失败时不会留下半注册 Layer。源表是外部/既有对象，删除 Layer 不删除表。

## 文件导入（3 项）

| 方法 | 路径 | 请求与响应 | 实现 / 测试 |
|---|---|---|---|
| POST | /api/v1/projects/{project_id}/layers/import | multipart：file 必填、name 可选。支持 .geojson、.json、.gpkg、.zip、.shp、.gml、.kml。文件按 GIS_UPLOAD_MAX_BYTES 限制，默认 512 MiB。成功 LayerRead，201。 | [imports.py](../../backend/app/api/v1/routes/imports.py)、[vector_import_service.py](../../backend/app/services/vector_import_service.py)、[test_vector_import.py](../../backend/tests/test_vector_import.py) |
| POST | /api/v1/projects/{project_id}/layers/import-raster | multipart：file 必填、name 可选。支持 .tif、.tiff、.vrt、.img、.jp2。必须有 CRS 且能算出 band statistics；成功时存为 COG 并返回 LayerRead，201。 | [imports.py](../../backend/app/api/v1/routes/imports.py)、[raster_import_service.py](../../backend/app/services/raster_import_service.py)、[test_raster_import.py](../../backend/tests/test_raster_import.py) |
| POST | /api/v1/projects/{project_id}/layers/import-draft | JSON ImportDraftRequest：name 1–200 字符，sourceFilename 1–255 字符，featureCollection 必须是已规范化 GeoJSON FeatureCollection。成功 ImportResult，201；失败 422，错误列表在 error.details.errors，不返回部分成功结果。 | [imports.py](../../backend/app/api/v1/routes/imports.py)、[import_draft.py](../../backend/app/schemas/import_draft.py)、[draft_import_service.py](../../backend/app/services/draft_import_service.py)、[test_import_draft.py](../../backend/tests/test_import_draft.py) |

Draft validation 支持 Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon；坐标按经纬度范围检查，不能是 NaN/Infinity。Polygon ring 未闭合会自动闭合并报告 warning。任何 feature 错误导致整份导入失败；稀疏字段和混合属性类型是 warning，属性 key/value 不重命名，嵌套 JSON 保留。最大 feature 数由 GIS_IMPORT_MAX_FEATURES 默认 50,000 控制。

GET /api/v1/system/import-limits 会返回 .json/.geojson、64 MiB、50,000 features、5,000 preview 等 staged-import 配置。当前后端 draft 服务执行 feature 上限；allowedExtensions、maxFileBytes、previewMaxFeatures 只通过该接口报告，并未在 draft route 自身执行扩展名/字节长度检查。普通文件上传使用另一套扩展名集合和 GIS_UPLOAD_MAX_BYTES。

## 要素、属性和瓦片（9 项）

| 方法 | 路径 | 请求与响应 | 实现 / 测试 |
|---|---|---|---|
| GET | /api/v1/layers/{layer_id}/features | 必填 query bbox=minx,miny,maxx,maxy，EPSG:4326；可传 limit、simplify、precision。返回 GeoJSON FeatureCollection，带 returned/limit/truncated。支持 If-None-Match，命中时 304；成功响应 Cache-Control 为 no-cache。 | [features.py](../../backend/app/api/v1/routes/features.py)、[feature_service.py](../../backend/app/services/feature_service.py)、[test_features_api.py](../../backend/tests/test_features_api.py) |
| GET | /api/v1/layers/{layer_id}/fields | 无请求体；返回字段元数据、idColumn、geometryColumn。fields 列表去掉 geometry，但包含 ID 列；editable 表示数据库列属性。 | [features.py](../../backend/app/api/v1/routes/features.py)、[attribute_service.py](../../backend/app/services/attribute_service.py)、[test_attributes_api.py](../../backend/tests/test_attributes_api.py) |
| GET | /api/v1/layers/{layer_id}/attributes | query：page 默认 1；pageSize 默认 50、最大 500；sortBy 默认 id column；sortOrder 默认 asc，仅 asc/desc；filters 是 JSON 字符串数组。返回 columns/rows/page/pageSize/total/totalEstimated。 | 同上 |
| GET | /api/v1/layers/{layer_id}/statistics | 无请求体；读取 raster_file 来源的各波段统计。用于非 raster source 时返回 invalid_request。 | [features.py](../../backend/app/api/v1/routes/features.py)、[raster_tile_service.py](../../backend/app/services/raster_tile_service.py)、[test_raster_tiles_api.py](../../backend/tests/test_raster_tiles_api.py) |
| POST | /api/v1/layers/{layer_id}/features | body {geometry:{...}, properties?:{...}}，geometry 必填，properties 默认空对象。geometry 坐标按 EPSG:4326 接收并转存到图层 SRID。返回新 Feature，201。 | [features.py](../../backend/app/api/v1/routes/features.py)、[edit_service.py](../../backend/app/services/edit_service.py)、[test_editing_api.py](../../backend/tests/test_editing_api.py) |
| PATCH | /api/v1/layers/{layer_id}/features/{feature_id} | body 可含 geometry 和/或 properties。properties null/省略视为不改；geometry null/省略视为不改；两者都不提供或空 properties 时拒绝。至少要有非空 properties 或非 null geometry。返回更新后的 Feature。 | 同上 |
| DELETE | /api/v1/layers/{layer_id}/features/{feature_id} | 成功 204；找不到要素为 404。数据库约束错误映射为 invalid_request。 | 同上 |
| GET | /api/v1/layers/{layer_id}/tiles/{z}/{x}/{y}.mvt | path z/x/y；z 限 0–24，x/y 各在 [0,2^z)。返回 Mapbox Vector Tile；空瓦片 204；支持 ETag/304；缓存头 public, max-age=60。 | [tiles.py](../../backend/app/api/v1/routes/tiles.py)、[tile_service.py](../../backend/app/services/tile_service.py)、[test_vector_tiles_api.py](../../backend/tests/test_vector_tiles_api.py) |
| GET | /api/v1/layers/{layer_id}/tiles/{z}/{x}/{y}.png | 相同 XYZ 范围；栅格覆盖外 204；成功 image/png；支持 ETag/304 和 public 60 秒缓存头。 | [tiles.py](../../backend/app/api/v1/routes/tiles.py)、[raster_tile_service.py](../../backend/app/services/raster_tile_service.py)、[test_raster_tiles_api.py](../../backend/tests/test_raster_tiles_api.py) |

Feature bbox 会拒绝经纬度超范围、min≥max 或格式错误。服务默认 feature 上限 GIS_FEATURE_BBOX_LIMIT=2000；limit 大于此值时返回 422，而非静默截到上限。查询使用 GiST 可用的 bbox overlap &&，没有额外精确 ST_Intersects 过滤，所以语义是空间包围盒候选。GeoJSON 返回 EPSG:4326，properties 排除主键与 geometry；truncated 明确说明是否超过限制。precision 默认 6、小数位最多 9；simplify 单位为 4326 度，点图层忽略该参数，0 等同于不简化。

属性 filter 格式为 [{field, op, value}]，多个条件 AND 连接；field 必须是实际属性列。op 固定为 eq、neq、gt、gte、lt、lte、like、ilike、in、isnull、notnull；in 必须是非空数组，isnull/notnull 不读取 value。值使用 SQL bind 参数。无过滤且 planner estimate 高于阈值时 total 可能是估算值，此时 totalEstimated=true；有过滤总数始终精确。详情见 [attribute schema](../../backend/app/schemas/attribute.py) 与 [feature repository](../../backend/app/repositories/feature_repository.py)。

要素、字段、属性和 MVT 要求可验证的 PostgisSource；raster PNG 要求 RasterFileSource。路由按 layer_id 取图层，没有额外用户/项目权限验证。编辑只允许数据库标为 editable 且不是 id/geometry 的列，此外写 SQL 的请求列名必须满足全小写标识符规则。

当前 MVT LRU key 和 GeoJSON ETag 都使用 Layer.updated_at；编辑接口只更新源表，没有更新 Layer row。因此编辑后可能仍复用旧 MVT 缓存或相同 GeoJSON ETag。现有 [fast-path tests](../../backend/tests/test_perf_fastpath.py) 检验 Layer.updated_at 改变后的 tile cache miss，没有覆盖要素编辑的缓存新鲜度。

## 后台任务（7 项）

| 方法 | 路径 | 请求与响应 | 实现 / 测试 |
|---|---|---|---|
| POST | /api/v1/projects/{project_id}/tasks/import | multipart file 必填、name 可选；排队矢量导入，返回 TaskRead，202。服务端把上传留在 tmp/tasks 下，任务参数含 uploadPath/name/sourceFilename。 | [tasks.py](../../backend/app/api/v1/routes/tasks.py)、[task_service.py](../../backend/app/services/task_service.py)、[test_tasks.py](../../backend/tests/test_tasks.py) |
| GET | /api/v1/tasks | query projectId、type（kind）、state、createdAfter、page 默认 1、pageSize 默认 20/最大 100。返回 TaskPage；按 created_at/id 倒序稳定分页。 | 同上 |
| GET | /api/v1/tasks/{task_id} | 返回 TaskRead，包括状态、阶段、进度、params/result/error、provenance、retryable、时间与 durationMs。 | 同上 |
| GET | /api/v1/tasks/{task_id}/logs | 返回最多最近 200 条带 ts/level/message 的任务日志。 | 同上 |
| POST | /api/v1/tasks/{task_id}/cancel | queued 任务立即 cancelled；running 改为 cancelling，由 handler 在检查点协作取消；返回 TaskRead，202。终态重复取消为 409。 | 同上 |
| POST | /api/v1/tasks/{task_id}/retry | failed/cancelled 且输入仍存在时复制参数创建新 queued task，retryOf 指向原 task；201。其他状态为 409；原输入不可用为 422。 | 同上 |
| GET | /api/v1/tasks/{task_id}/result | 仅 succeeded 可读取；其他状态返回 409。若 result 为 null，响应 {}。 | 同上 |

任务状态为 queued → running → succeeded/failed；running 可进 cancelling，cancelling 可以 succeeded、failed 或 cancelled 结束，queued 可直接 cancelled。应用启动时 running/cancelling 被标成 failed/interrupted，不会从中间 checkpoint 恢复。worker 是应用 lifespan 中的进程内 asyncio loop，不是外部 broker。进度/log 会由 TaskContext.report 提交以供客户端轮询。

取消只在 handler 写有 check_cancelled 的边界生效，不能保证硬中断。analysis 的结果表创建后有取消检查；该检查点取消时没有清理 CTAS 表。vector export 在文件生成后检查取消，因此可能留下不可下载的文件；raster export 当前没有取消检查点。同步导入也会写入任务历史，但其终态记录无重试参数。任务状态代码见 [task_lifecycle.py](../../backend/app/services/task_lifecycle.py)、[task_worker.py](../../backend/app/services/task_worker.py) 和 [task_handlers.py](../../backend/app/services/task_handlers.py)。

## 空间分析（7 项）

所有分析接口返回 TaskRead，状态码 202；请求中的 project_id 决定 task 所属和输出图层的目标 project。handler 要求输入 layer.kind 为 vector；代码不校验输入 layer.project_id 是否与路径 project_id 相同。

| 方法与路径 | JSON 请求字段 | 实际输出语义 | 实现 / 测试 |
|---|---|---|---|
| POST /api/v1/projects/{project_id}/analysis/buffer | layerId、distanceMeters（>0 且 ≤10,000,000）、outputName | 以 geography 做米制 buffer，保留输入属性，生成新 vector 图层。 | [analysis.py](../../backend/app/api/v1/routes/analysis.py)、[analysis_service.py](../../backend/app/services/analysis_service.py)、[test_analysis.py](../../backend/tests/test_analysis.py) |
| POST /api/v1/projects/{project_id}/analysis/clip | layerId、maskLayerId、outputName | 将 mask union 后与目标几何求交，只保留相交目标记录；保留目标属性。 | 同上 |
| POST /api/v1/projects/{project_id}/analysis/intersection | layerId、otherLayerId、outputName | 输出非空交集，双方属性分别加 a_ / b_ 前缀，fid 由 row_number 生成。 | 同上 |
| POST /api/v1/projects/{project_id}/analysis/dissolve | layerId、byField 可选、outputName | 有 byField 时按字段聚合；无字段时整表聚合。输出 merged_count 和 union geometry。 | 同上 |
| POST /api/v1/projects/{project_id}/analysis/spatial-join | targetLayerId、joinLayerId、predicate 可选、outputName | predicate 为 intersects/contains/within，默认 intersects。每个 target 通过 LEFT JOIN LATERAL 最多选一个匹配记录，join 字段带 join_ 前缀。 | 同上 |
| POST /api/v1/projects/{project_id}/analysis/validate-repair | layerId、outputName | 对无效几何使用 ST_MakeValid，输出 repairedCount。 | 同上 |
| POST /api/v1/projects/{project_id}/analysis/point-in-polygon | pointsLayerId、polygonsLayerId、outputName | 每个 polygon 计算 ST_Contains 的点数，字段名 point_count。 | 同上 |

outputName 必填，1–200 字符。分析是数据库 CTAS 工作，不会把几何整体拉到 Python 执行；每个结果写 gis_data、建主键和 GiST 索引、ANALYZE 并注册 Layer。跨 SRID 输入几何由服务转换至 EPSG:4326。

## 导出（3 项）

| 方法 | 路径 | 请求与响应 | 实现 / 测试 |
|---|---|---|---|
| POST | /api/v1/projects/{project_id}/exports/vector | JSON：layerId、format 必填；format 为 geojson/csv/gpkg/shp；fields 可选；crs 默认 4326，范围 1–999999；filters、featureIds（最多 10,000 项）、bbox（长度恰好 4）可选；filename 最多 120 字符。返回 TaskRead，202。 | [exports.py](../../backend/app/api/v1/routes/exports.py)、[export_service.py](../../backend/app/services/export_service.py)、[test_exports.py](../../backend/tests/test_exports.py) |
| POST | /api/v1/projects/{project_id}/exports/raster | JSON：layerId 必填；format 只能是 gtiff，默认 gtiff；filename 可选、最多 120 字符。返回 TaskRead，202。 | 同上 |
| GET | /api/v1/tasks/{task_id}/download | 只允许已成功的 export_* task；流式下载结果文件。非导出/未成功为 409，磁盘文件不存在为 404。下载会更新 provenance.lastDownloadedAt。 | [exports.py](../../backend/app/api/v1/routes/exports.py)、[test_exports.py](../../backend/tests/test_exports.py) |

矢量字段选择必须是 catalog 中的属性列；未提供时导出全部属性。过滤格式与属性 API 一致，bbox 是四个数的数组，但 schema 没有校验坐标范围或 min/max 顺序。无匹配要素返回 invalid_request，不产生空文件。Shapefile 的 sidecars 被打成 ZIP；CSV geometry 写为 WKT；非 4326 输出执行重投影。栅格导出复制源 COG。结果文件写在 GIS_DATA_DIR/exports，task.result 含 file、downloadName、sizeBytes 和 retention=manual；当前没有定时清理。

导出接口通过 URL project_id 建立 task，但 handler 仅按 body layerId 加载源图层，没有校验图层属于 URL 项目。此路径字段承担 task/history 归属，不是跨项目访问控制。

## 系统信息（3 项）

| 方法 | 路径 | 响应 | 实现 / 测试 |
|---|---|---|---|
| GET | /api/v1/system/memory | 进程 RSS、raster pool 统计、featureBboxLimit、attributePageMax。应用 lifespan 尚未初始化 pool 时返回 503。 | [system.py](../../backend/app/api/v1/routes/system.py)、[system_service.py](../../backend/app/services/system_service.py)、[test_system_api.py](../../backend/tests/test_system_api.py) |
| GET | /api/v1/system/import-limits | allowedExtensions、maxFileBytes、maxFeatures、previewMaxFeatures，值来自 GIS_IMPORT_* 配置。是否由后端强制执行见导入章节。 | 同上 |
| GET | /api/v1/system/overview | projectCount、layerCount、layersByKind、featureTotal、最多 8 个 recentLayers。 | 同上 |

完整服务配置和持久化关系见[后端架构地图](backend.md)；OpenAPI UI 使用 FastAPI 默认 /docs。
