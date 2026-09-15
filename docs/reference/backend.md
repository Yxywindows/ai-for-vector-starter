# 后端架构与业务代码地图

本文把业务能力映射到当前后端实现和测试，供 AI 或开发者沿着代码链定位。结论以实现和测试为准；接口细节看 [API 清单](api.md)。架构涉及的概念教学材料仍在 [docs/learning](../learning/01-architecture-overview.md)。

## 请求如何进入业务

默认路由前缀由 GIS_API_PREFIX 配置，值为 /api/v1。应用工厂在 [backend/app/main.py](../../backend/app/main.py) 注册 CORS、异常处理、带前缀的版本化 router 和额外的裸 /health；[backend/app/api/v1/router.py](../../backend/app/api/v1/router.py) 汇总各资源路由。多数访问数据库的路由由 SessionDep 注入请求级 AsyncSession；health、system/memory、system/import-limits 不依赖数据库 session，system/overview 依赖数据库。

路由到业务的主要关系是：HTTP route 解析输入 schema 并取得 request AsyncSession；service 执行业务规则；repository/SQL 读写 PostgreSQL/PostGIS；需要处理栅格或导入导出文件时再访问文件系统或 raster reader pool。task API 建立 task row 后由应用内 worker 调用 handler，handler 复用同一批业务 service。

| 层 | 主要职责 | 代码入口 |
|---|---|---|
| API | 解析 path、query、JSON、multipart；组装响应和状态码；不承载空间业务逻辑 | [backend/app/api/v1/routes](../../backend/app/api/v1/routes) |
| Schema | Pydantic 请求/响应契约、别名、联合类型与范围约束 | [backend/app/schemas](../../backend/app/schemas) |
| Service | 业务规则、跨表流程、数据源类型检查、文件/任务生命周期 | [backend/app/services](../../backend/app/services) |
| Repository | SQLAlchemy 查询、PostGIS SQL、动态表/列访问 | [backend/app/repositories](../../backend/app/repositories) |
| Model | gis 元数据 ORM，包括 Project、Layer、Task | [backend/app/models](../../backend/app/models) |
| Runtime resource | 有界的栅格 Reader 池 | [backend/app/resources/dataset_pool.py](../../backend/app/resources/dataset_pool.py) |
| Core / DB | 配置、错误、日志、PROJ 初始化、数据库会话和 SQL 标识符 | [backend/app/core/config.py](../../backend/app/core/config.py)、[backend/app/db/session.py](../../backend/app/db/session.py) |

业务链应按 route → schema → service 或 task handler → repository/model → test 阅读。Task 没有单独 repository；任务查询和状态持久化在 task service、worker 直接使用 ORM。

## 数据归属与关系

Alembic 的 0001 migration 建立 PostGIS 扩展、gis 和 gis_data schema，以及 gis.project、gis.layer。0002 给 Layer 增加 source_filename；0003 建立 gis.task 并把已有 source_filename 图层回填为成功的 vector_import 记录。迁移序列见 [0001](../../backend/migrations/versions/0001_initial_schema.py)、[0002](../../backend/migrations/versions/0002_layer_source_filename.py)、[0003](../../backend/migrations/versions/0003_task_table.py)。

| 数据 | 存放位置 | 业务含义与删除边界 |
|---|---|---|
| Project、Layer、Task | PostgreSQL 的 gis schema | Project 拥有排序后的图层；Layer 名在同一 project 内唯一。删除图层会保留任务行并把 task.layer_id 置空；删除 project 会由外键级联删除其 layer 与 task 元数据。 |
| 导入的矢量表、分析结果表 | PostgreSQL 的 gis_data schema | 动态表没有 ORM model，也不由 Alembic 管理；Layer.source 以 PostgisSource 指向这些表。分析输出也写入该 schema。 |
| 栅格 COG | GIS_DATA_DIR/rasters | Layer.source 存相对路径、波段和 nodata 等描述；读取时先验证解析路径仍在 raster_dir 内。 |
| 项目缩略图 | GIS_DATA_DIR/thumbnails/{project_id}.png | 原始请求 body 直接写文件；元数据不记录缩略图路径。 |
| 导出文件 | GIS_DATA_DIR/exports/{task_id}.* | Task.result 记录文件名和下载名；返回值声明 retention 为 manual，当前没有定时清理流程。 |
| 上传临时文件 | GIS_DATA_DIR/tmp | 同步导入完成后清理；异步 vector_import 上传失败时保留以供 retry，成功时删除。 |

Layer.source 是按 type 判别的 PostgisSource、RasterFileSource、XyzSource 或 MvtSource；Layer.kind 是 vector、raster、vector_tile 或 basemap。schema 分别校验两个字段，但不校验 source 与 kind 的组合。代码实际提供 PostGIS feature/MVT 查询与 raster_file PNG 渲染；未提供把 XyzSource 或 MvtSource URL 代理为本后端瓦片的接口。通用图层创建可以保存这些类型，不能据此推断所有服务端读取接口均支持它们。定义见 [source.py](../../backend/app/schemas/source.py) 和 [layer.py](../../backend/app/schemas/layer.py)。

图层或项目删除只处理元数据，没有调用 DROP TABLE、删除 COG 或清理项目文件的业务步骤；动态矢量表和栅格源文件可能继续留在存储中。删除 project 会级联删除任务行，因此“任务 API 没有删除任务接口”不代表 project 删除后任务历史永久保留。实现边界见 [layer_service.py](../../backend/app/services/layer_service.py)、[project_service.py](../../backend/app/services/project_service.py)、[layer_repository.py](../../backend/app/repositories/layer_repository.py) 与 [models](../../backend/app/models)。

## 业务能力到源码和测试

| 业务能力 | 入口 → 业务实现 → 持久化 | 主要测试 |
|---|---|---|
| 项目、图层和图层排序 | [projects route](../../backend/app/api/v1/routes/projects.py)、[layers route](../../backend/app/api/v1/routes/layers.py) → [project_service](../../backend/app/services/project_service.py)、[layer_service](../../backend/app/services/layer_service.py) → project/layer repository 和 ORM | [test_projects_api.py](../../backend/tests/test_projects_api.py)、[test_layers_api.py](../../backend/tests/test_layers_api.py)、[test_models.py](../../backend/tests/test_models.py) |
| 发现/登记已有 PostGIS 表 | [catalog route](../../backend/app/api/v1/routes/catalog.py) → [catalog_service](../../backend/app/services/catalog_service.py) → [catalog_repository](../../backend/app/repositories/catalog_repository.py)，然后创建 Layer | [test_catalog_api.py](../../backend/tests/test_catalog_api.py)、[test_identifiers.py](../../backend/tests/test_identifiers.py) |
| 矢量文件导入 | [imports route](../../backend/app/api/v1/routes/imports.py) 或 task import route → [upload_service](../../backend/app/services/upload_service.py)、[vector_import_service](../../backend/app/services/vector_import_service.py) → GeoPandas/pyogrio + gis_data 动态表 + Layer | [test_upload_service.py](../../backend/tests/test_upload_service.py)、[test_vector_import.py](../../backend/tests/test_vector_import.py) |
| 已编辑 GeoJSON 草稿导入 | imports route → [draft_import_service](../../backend/app/services/draft_import_service.py)、[geojson_validation](../../backend/app/services/geojson_validation.py) → 共用 vector 写入流程 | [test_import_draft.py](../../backend/tests/test_import_draft.py)、[test_geojson_validation.py](../../backend/tests/test_geojson_validation.py) |
| 栅格导入、COG、XYZ PNG 与统计 | imports route → [raster_import_service](../../backend/app/services/raster_import_service.py)、[raster_tile_service](../../backend/app/services/raster_tile_service.py) → COG 文件和 [DatasetPool](../../backend/app/resources/dataset_pool.py) | [test_raster_import.py](../../backend/tests/test_raster_import.py)、[test_raster_tiles_api.py](../../backend/tests/test_raster_tiles_api.py)、[test_dataset_pool.py](../../backend/tests/test_dataset_pool.py)、[test_geo_env.py](../../backend/tests/test_geo_env.py) |
| GeoJSON feature 查询 | features route → [feature_service](../../backend/app/services/feature_service.py)、[source_snapshot](../../backend/app/services/source_snapshot.py) → [feature_repository](../../backend/app/repositories/feature_repository.py) | [test_features_api.py](../../backend/tests/test_features_api.py)、[test_bbox_parsing.py](../../backend/tests/test_bbox_parsing.py)、[test_perf_fastpath.py](../../backend/tests/test_perf_fastpath.py) |
| 属性字段、分页与过滤 | features route → [attribute_service](../../backend/app/services/attribute_service.py) → feature/catalog repository | [test_attributes_api.py](../../backend/tests/test_attributes_api.py)、[test_perf_fastpath.py](../../backend/tests/test_perf_fastpath.py) |
| 要素新增、修改、删除 | features route → [edit_service](../../backend/app/services/edit_service.py) → feature repository；geometry 交给 PostGIS 检查 | [test_editing_api.py](../../backend/tests/test_editing_api.py)、[test_session.py](../../backend/tests/test_session.py) |
| MVT | tiles route → [tile_service](../../backend/app/services/tile_service.py)、source snapshot → [tile_repository](../../backend/app/repositories/tile_repository.py) 的 ST_AsMVT | [test_vector_tiles_api.py](../../backend/tests/test_vector_tiles_api.py)、[test_tile_coords.py](../../backend/tests/test_tile_coords.py)、[test_perf_fastpath.py](../../backend/tests/test_perf_fastpath.py) |
| 异步分析 | analysis route 只排队 → [task_worker](../../backend/app/services/task_worker.py) → [analysis_service](../../backend/app/services/analysis_service.py) 在 PostGIS 做 CTAS 并注册 vector Layer | [test_analysis.py](../../backend/tests/test_analysis.py)、[test_tasks.py](../../backend/tests/test_tasks.py) |
| 矢量/栅格导出 | exports route 只排队 → [export_service](../../backend/app/services/export_service.py) 生成文件 → download route 流式返回 | [test_exports.py](../../backend/tests/test_exports.py) |
| 运行信息与健康检查 | system/health routes → [system_service](../../backend/app/services/system_service.py)、[main.py](../../backend/app/main.py) | [test_system_api.py](../../backend/tests/test_system_api.py)、[test_health.py](../../backend/tests/test_health.py) |

## 导入、分析和导出的边界

### 矢量写入

文件 vector import 接受 .geojson、.json、.gpkg、.zip、.shp、.gml、.kml。上传流按 1 MiB 分块落临时磁盘，GIS_UPLOAD_MAX_BYTES 默认 512 MiB；ZIP 解包前拒绝绝对路径、盘符路径和 ..。文件由 pyogrio 读取，无 CRS 时按 GeoJSON 的 CRS84/4326 处理，之后统一转为 EPSG:4326 和 geometry 列。

草稿 import 的 body 必须已经是 FeatureCollection。服务端再次验证六种 GeoJSON 几何结构、坐标范围和 JSON 属性；任何错误都拒绝整份输入，开放 polygon ring 会自动闭合并产生 warning。缺失属性落库为 NULL；混合属性类型产生 warning，保留原值。属性 key 不做重命名或安全字符过滤，因此动态表的列名可能包含大小写或特殊字符。

两种入口共用 [write_frame_and_register](../../backend/app/services/vector_import_service.py)：GeoPandas 的 to_postgis 通过单独的同步 psycopg NullPool engine 执行，随后建立 fid 主键/identity、geometry GiST 索引并 ANALYZE，Layer 元数据由请求 AsyncSession 写入。同步 SQL 连接已提交的动态表不受请求事务回滚控制；服务用失败时 DROP TABLE 做补偿。成功路径写入 gis_data，来源和 layer metadata 指向新表。

feature 编辑还有额外的写入限制：只允许 catalog 判定为 editable 且不是主键、geometry 的列；SQL 标识符还必须符合全小写 ASCII 标识符规则。因此从草稿导入后保留了大写/特殊字符的字段可以读取和用于瓦片，但编辑 API 可能拒绝写这些字段。

### 栅格写入与读取

栅格导入接受 .tif、.tiff、.vrt、.img、.jp2。必须能读取 CRS 和 band statistics；有效 COG 原样复制，其余通过 rio-cogeo 转成 COG。来源只保存生成的随机文件名，且路径每次读取都检查不得越出 raster_dir。失败时删除目标 COG；普通 Layer 删除没有对应的文件回收。

tile read 使用 rio-tiler 的 Reader 和 DatasetPool。池按文件绝对路径做 LRU，限制打开数量和闲置时间；同一 handle 串行使用，不同 handle 可并行，打开与关闭固定在该 handle 专属线程。PNG 栅格渲染使用 Layer 的 RasterStyle bands/rescale/colormap；未知 colormap 是 invalid_request，磁盘文件缺失映射为 upstream_data_error。

### 分析与导出

分析 API 只接受 vector 图层，具体工作由 task handler 在 PostGIS 执行 CTAS；新表索引、ANALYZE 后注册为请求路径 project 下的新 Layer。源 layer ID 由 handler 单独解析，没有检查其 project_id 是否等于 URL 的 project_id；URL project 决定 task 所属和分析结果写入的 project。空间操作定义见 [analysis_service.py](../../backend/app/services/analysis_service.py)。

矢量导出由 worker 查询并将所选记录全部 .all() 读入当前进程，再在线程中组装 GeoDataFrame 和写文件；它不是流式数据库导出。格式为 GeoJSON、CSV/WKT、GeoPackage 或 ZIP Shapefile，支持筛选字段、属性过滤、feature ID、bbox 和重投影。bbox schema 只限制长度为四个数，不执行 BBox 同样的顺序/经纬度范围校验。栅格导出复制已登记 COG。导出文件保存在 data_dir/exports 并标记手动保留，无定时清理；下载时更新 task.provenance.lastDownloadedAt。

## 任务状态、事务和副作用

任务统一存于 gis.task。合法迁移由 [task_lifecycle.py](../../backend/app/services/task_lifecycle.py) 定义：queued 可到 running 或 cancelled；running 可到 succeeded、failed 或 cancelling；cancelling 可到 cancelled、failed 或 succeeded；三个终态不能再迁移。

生产 lifespan 启动时把 task 表中所有 running/cancelling 行改为 failed/interrupted，再启动进程内 asyncio worker；恢复 SQL 没有 worker/process owner 条件。因此当前任务恢复语义要求单个 backend worker 进程部署：若另一个仍在工作的进程同时启动，它也可能把其他进程正在执行的任务标为 interrupted。worker 按 created_at/id 排队并以 FOR UPDATE SKIP LOCKED 领取任务；新增 task 用 notify 唤醒，空闲时轮询。它不是消息队列，输入/任务数据保存在同一个 PostgreSQL 里。

取消是协作式：API 将 queued 直接置为 cancelled，将 running 置为 cancelling；handler 只在显式 check_cancelled 检查点响应。没有检查点的长操作可能成功结束。当前分析 handler 在 CTAS 之后检查取消；若此时取消，worker 会提交 task 的 cancelled 状态，而这个检查点没有调用分析结果表清理。矢量导出在文件写完后再检查取消，取消时已写文件没有通用清理；栅格导出 handler 没有取消检查点。不要把 cancel 理解成数据库/文件系统的强制中断或原子回滚。

同步 vector/raster/draft import 也会写入共享 task history，记录为同步执行的终态 task；历史记录没有可重跑 params。异步 vector import 在失败时保留上传文件供 retry，成功时移除；retry 创建新 task 并通过 retry_of 保留链路，不覆盖原记录。

事务归属：

- HTTP 请求由 [get_session](../../backend/app/db/session.py) 维护一个 AsyncSession；成功提交，异常回滚。依赖使用 function scope，提交发生在响应发给客户端之前。service/repository 常执行 flush，但普通请求业务不会自行 commit。
- 后台 worker 使用自己的 SessionLocal；TaskContext.report 会提交阶段和日志以便轮询客户端即时读取，因此任务 handler 不是一个覆盖全程的单事务。
- 上传临时文件、COG 和导出文件属于文件系统副作用，不会随数据库回滚自动撤销。矢量文件/draft import 的 to_postgis 在单独的同步 psycopg 事务提交动态表，再由服务在后续 Layer 注册失败时 DROP 表补偿。分析 CTAS 使用 worker 的 AsyncSession；其结果表在之后的 TaskContext.report 提交阶段一并变为持久数据，注册失败时 analysis service 回滚并显式删除结果表。图层/项目删除没有源数据清理；导出 retention 是手动。
- gis_data 动态表由运行时创建，不属于 Alembic metadata。Alembic 的过滤边界由 [migrations/env.py](../../backend/migrations/env.py) 控制；[test_alembic_env.py](../../backend/tests/test_alembic_env.py) 保证它不会对这些表生成 drop。

## 动态 SQL、安全和缓存

直接来自请求的 schema/table/geometry/id/sort/filter 等 SQL 名称由 [identifiers.py](../../backend/app/db/identifiers.py) 的小写 ASCII 规则验证；目录中读出的字段先检查它确实是目标表的列，再使用独立的 PostgreSQL quoted-identifier 转义。值用绑定参数，filter operators 来自固定集合。不要把请求字符串直接拼进 SQL，也不要把 catalog 字段误当成通过 validate_identifier 验证过的字段。

PostGIS 数据源进入动态 SQL 前由 catalog service 检查表和 geometry/id 列。表或列不存在时返回 404。目录快照以 (layer_id, layer.updated_at) 作进程内 LRU key，默认最多 512 项；直接在数据库改表结构而不触碰 Layer 行时，列快照可能一直不可见直到缓存淘汰、进程重启或 Layer 更新时间改变。

MVT 有独立的进程内字节 LRU，默认上限 64 MiB，key 含 layer id、updated_at 和 z/x/y；响应还发弱 ETag 与 public 60 秒 Cache-Control。GeoJSON feature ETag 按 layer id、updated_at 与查询参数构造，响应为 no-cache。Layer row 更新可改变两种 key，但 feature 编辑仅更新源表、没有更新 Layer 行；因此 feature data 改变后 MVT 缓存 key/GeoJSON ETag 可能仍保持不变。现有 fast-path 测试覆盖 Layer 更新时间后的 tile cache miss，没有覆盖编辑后的缓存失效。

无过滤属性总数在表很大且 planner 有估算时使用 reltuples，响应 totalEstimated=true；小表、未 ANALYZE 表和所有过滤结果使用精确 count。功能代码见 [feature_repository.py](../../backend/app/repositories/feature_repository.py)，验证见 [test_perf_fastpath.py](../../backend/tests/test_perf_fastpath.py)。

当前 API 没有声明认证或授权依赖。所有请求范围由 URL ID 和数据库存在性约束，不能把 projectId 当成访问控制检查。

## 错误、配置和测试

[错误处理器](../../backend/app/core/errors.py)统一返回 error: {code, message, details}。业务错误映射：404 not_found、409 conflict、422 invalid_request、415 unsupported_format、413 payload_too_large、502 upstream_data_error、503 service_unavailable；Pydantic 验证也是 422 invalid_request，未处理异常对外返回通用 500 internal_error。测试见 [test_errors.py](../../backend/tests/test_errors.py)。

高频配置集中在 [config.py](../../backend/app/core/config.py)：异步数据库 URL、data_dir、上传上限、元数据/导入 schema、BBOX/属性页/任务页上限、snapshot/tile 缓存、task worker 开关和间隔、raster pool 上限/TTL，以及草稿导入 feature 数限制。前缀是 GIS_。/system/import-limits 返回 allowedExtensions、maxFileBytes、maxFeatures、previewMaxFeatures；其中只有 maxFeatures 在本后端草稿导入路径被校验，allowedExtensions、maxFileBytes、previewMaxFeatures 是当前返回给客户端的配置值。普通文件导入走 GIS_UPLOAD_MAX_BYTES 与自己的扩展名集合。

测试是 PostGIS 集成测试，不是仅 mock SQL。运行方式、测试数据库保护及质量门见 [backend/README.md](../../backend/README.md)、[根 README](../../README.md) 和 [tests/conftest.py](../../backend/tests/conftest.py)。改接口应同时核对 route、schema、服务与 API 测试；改动态 SQL 应读 identifiers/catalog trust boundary 和注入/列名测试；改任务种类应检查 handler 注册、worker lifecycle 和 task tests；改 schema 只能为 gis 元数据添加 migration，gis_data 运行时表不加 ORM/Alembic model。
