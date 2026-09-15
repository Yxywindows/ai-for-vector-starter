# 代码地图

[AI 入口](README.md) · [业务映射](../business-map.md)

## 总入口

| 入口 | 下一跳 / 作用 |
|---|---|
| [web/src/main.tsx](../../web/src/main.tsx) | React 挂载与 QueryClientProvider |
| [web/src/app/router.tsx](../../web/src/app/router.tsx) | 平台路由、lazy App 地图路由与错误边界 |
| [web/src/App.tsx](../../web/src/App.tsx) | 地图工作区组装 |
| [backend/app/main.py](../../backend/app/main.py) | FastAPI、lifespan、worker 与资源池 |
| [backend/app/api/v1/router.py](../../backend/app/api/v1/router.py) | 全部 v1 路由注册 |
| [backend/app/core/config.py](../../backend/app/core/config.py) | GIS_ 配置与资源限制 |
| [docker-compose.yml](../../docker-compose.yml) | 数据库、pgAdmin 与持久卷 |

## 模块索引

| 目录 | 职责 / 首读文件 | 业务关联 |
|---|---|---|
| [web/src/pages](../../web/src/pages) | 平台页面；[DataCatalogPage](../../web/src/pages/DataCatalogPage.tsx) | B01/B02/B08/B09/B10 |
| [web/src/app](../../web/src/app) | 路由、壳层、查询客户端、项目切换、布局；[PlatformShell](../../web/src/app/PlatformShell.tsx) | B01/B12 |
| [web/src/api](../../web/src/api) | 请求封装与 wire 类型；[client](../../web/src/api/client.ts)、[types](../../web/src/api/types.ts) | 全部 HTTP 功能 |
| [web/src/features](../../web/src/features) | layers/import/attributes/editing/styling/memory 独立功能目录 | B03/B04/B06/B07/B11 |
| [web/src/map](../../web/src/map) | MapProvider、图层同步、加载、识别、样式和资源观测；[syncLayers](../../web/src/map/syncLayers.ts) | B05/B07/B11 |
| [web/src/state](../../web/src/state) | [layerStore](../../web/src/state/layerStore.ts)中的 UI 选择与状态 | B03/B05/B06 |
| [web/src/cache](../../web/src/cache) | geoCache、IDB、key 构造及单测；尚未接入地图 | 缓存基础模块 |
| [backend/app/api/v1/routes](../../backend/app/api/v1/routes) | 请求验证、响应封装与服务分派 | B01–B11 |
| [backend/app/schemas](../../backend/app/schemas) | Pydantic APIModel、source/style/feature/task 等契约 | 所有 API |
| [backend/app/services](../../backend/app/services) | 校验、导入、编辑、读取、后台工作和结果生成 | 全部服务端业务 |
| [backend/app/repositories](../../backend/app/repositories) | 项目/图层 ORM 与 catalog/feature/tile SQL | B01/B02/B03/B05/B06 |
| [backend/app/models](../../backend/app/models) | Project、Layer、Task | 持久业务元数据 |
| [backend/app/db](../../backend/app/db) | Base、异步请求会话、同步地理写连接、标识符 | SQL 与事务底座 |
| [backend/app/resources](../../backend/app/resources) | DatasetPool 独占句柄借用与逐出 | B11 |
| [backend/app/core](../../backend/app/core) | 设置、日志、地理环境、统一错误 | 横切能力 |
| [backend/migrations](../../backend/migrations) | 0001 初始结构、0002 source_filename、0003 task | 元数据结构版本 |
| [backend/tests](../../backend/tests) | pytest 与空间/栅格夹具 | API、服务、SQL 和迁移验证 |
| [web/bench](../../web/bench) / [backend/scripts](../../backend/scripts) | 浏览器测量 / 基准数据 SQL | 性能观测 |

完整后端职责及符号在[后端参考](../reference/backend.md)，前端路由/状态及测试在[前端参考](../reference/frontend.md)，方法和路径清单在[API 参考](../reference/api.md)。

## 按问题读代码

| 任务 | 最小阅读链 |
|---|---|
| 导入失败 | AddLayerDialog → imports.ts → routes/imports.py 或 tasks.py → upload/draft/vector/raster service → 对应 import 测试 |
| 地图没显示数据 | Project API 返回 Layer → WorkspaceSync / syncLayers → tierFor → createOlLayer → featureLoader 或瓦片 URL → 后端 source 验证 / SQL |
| 属性编辑失败 | AttributeTable / useAttributes → features.ts → edit_service → feature_repository → test_editing_api |
| 任务卡住 | TasksPage → tasks API → task_service → task_worker.run_once → get_handler → TaskContext.check_cancelled/report |
| 分析结果不对 | AnalysisPage 表单 → schemas/analysis → analysis_service 对应 handler → PostGIS SQL → test_analysis |
| 下载失败 | ExportsPage → exports 路由 → Task 状态/result → export_dir 与文件存在性 → test_exports |
| 样式未应用 | StyleEditor → Layer PATCH → syncLayers/applyLayerProperties → compileStyle；栅格同时看 raster_tile_service |
| 数据陈旧 | Layer.updated_at → source_snapshot / tile_service / feature ETag；另核对写入是否触碰 Layer；不要假设 geoCache 已接入 |
| 内存异常 | MapProvider / useLayerMemory → LayerMemoryManager / instrumentation；后端 DatasetPool 与 system_service |
| 迁移差异异常 | Base 命名 → models → migrations/env.py 的 schema 过滤/search_path → test_alembic_env |

## 快速检索

在仓库根目录：

```powershell
rg --files backend/app web/src backend/tests
rg -n 'APIRouter|@router\.' backend/app/api/v1/routes
rg -n 'register\(|async def|def ' backend/app/services/task_handlers.py backend/app/services/analysis_service.py backend/app/services/export_service.py
rg -n 'queryKey|invalidateQueries' web/src
rg -n 'geoCache|cachedTile|cachedFeatures' web/src
git diff --stat
```

测试与源码同名通常可直接定位；测试名称只是检索起点，必须检查覆盖的输入、断言与运行条件。

