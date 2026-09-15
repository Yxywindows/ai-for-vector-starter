# 开发、配置与验证

[目录](README.md) · [根 README](../README.md)

## 本地组件

| 组件 | 默认地址 | 来源 |
|---|---|---|
| PostGIS | localhost:5401 → 容器 5432 | [Compose](../docker-compose.yml)，postgis/postgis:16-3.4 |
| FastAPI | localhost:1316 | 启动命令指定；默认 API 前缀 /api/v1 |
| Vite | localhost:1317 | [package.json](../web/package.json) 与 [vite.config.ts](../web/vite.config.ts) |
| pgAdmin（可选） | localhost:5051 | Compose，可用 `docker compose up -d pgadmin` 启动 |

[Python 配置](../backend/pyproject.toml)要求 3.12+，依赖中含 GDAL 相关 Python 包。版本约束见 pyproject 和 requirements.lock.txt；前端以 package-lock.json 为安装快照。项目未设置 Node engines，不凭文档猜测最低版本。

## 启动与配置

按[根 README](../README.md)启动数据库、迁移、API 与前端。后端配置读取当前工作目录的 `.env` 和环境变量，前缀为 `GIS_`；从 backend 启动时相对 data_dir 默认落在 backend/var/data。

根 [.env.example](../.env.example)只有 POSTGRES_* 示例；当前 Compose 直接写了数据库值，不是读取这些变量进行插值。它也不是完整的后端配置模板。

| 环境变量 | 默认值 / 含义 |
|---|---|
| GIS_DATABASE_URL | postgresql+asyncpg://gis:gis@localhost:5401/gis_platform |
| GIS_API_PREFIX | /api/v1 |
| GIS_CORS_ORIGINS | JSON 数组，默认 ["http://localhost:1317"] |
| GIS_DATA_DIR | var/data |
| GIS_UPLOAD_MAX_BYTES | 536870912；通用上传 512 MiB |
| GIS_FEATURE_BBOX_LIMIT | 2000 |
| GIS_ATTRIBUTE_PAGE_MAX | 500 |
| GIS_ATTRIBUTE_COUNT_ESTIMATE_MIN | 100000；无过滤大表统计估算阈值 |
| GIS_RASTER_POOL_MAX_OPEN | 8 |
| GIS_RASTER_POOL_IDLE_TTL_SECONDS | 300 |
| GIS_TASK_WORKER_ENABLED | true |
| GIS_TASK_POLL_SECONDS | 1.0 |
| GIS_IMPORT_MAX_FILE_BYTES | 67108864；草稿文件 64 MiB |
| GIS_IMPORT_MAX_FEATURES | 50000 |
| GIS_IMPORT_PREVIEW_MAX_FEATURES | 5000 |
| GIS_SNAPSHOT_CACHE_MAX_ENTRIES | 512 |
| GIS_TILE_CACHE_MAX_BYTES | 67108864 |

其余设置以 [Settings](../backend/app/core/config.py)为准。`VITE_API_TARGET` 配置 Vite 开发代理；`VITE_PORT` 会被 vite.config.ts 读取，但 npm dev 脚本显式传入了 --port 1317，需要改端口时同时检查 CLI 参数。生产构建不携带 Vite 开发代理，需要部署环境提供 /api 转发和 SPA 路由回退。

## 数据库迁移

在 backend 目录执行：

```powershell
.\.venv\Scripts\alembic.exe current
.\.venv\Scripts\alembic.exe upgrade head
.\.venv\Scripts\alembic.exe current
```

[migrations/env.py](../backend/migrations/env.py)引导创建元数据 schema，并把迁移连接 search_path 固定为 public；autogenerate 只管理元数据 schema。动态导入表不进入 ORM 迁移管理。当前迁移链为 0001 → 0002 → 0003，见 [versions](../backend/migrations/versions)。

## 创建首个项目

首次使用时，当前项目页面没有创建表单，可在 API 文档中调用 POST /api/v1/projects，或在服务启动后执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:1316/api/v1/projects -ContentType 'application/json' -Body '{"name":"Demo"}'
```

这会新建项目；随后在前端项目列表打开其地图工作区并导入数据。

## 自动化测试

后端测试会重建测试库内元数据表，必须使用专用 `gis_platform_test`。首次在根目录创建测试数据库（已存在时跳过）：

```powershell
docker compose exec postgres psql -U gis -d postgres -c "CREATE DATABASE gis_platform_test OWNER gis;"
```

在专门的测试终端进入 backend：

```powershell
$env:GIS_DATABASE_URL = 'postgresql+asyncpg://gis:gis@localhost:5401/gis_platform_test'
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\ruff.exe check .
.\.venv\Scripts\ruff.exe format --check .
.\.venv\Scripts\mypy.exe app
```

[conftest.py](../backend/tests/conftest.py)拒绝不以 /gis_platform_test 结尾的连接串；使用真实 PostGIS、外层事务和请求 SAVEPOINT，禁用自动任务循环。导入测试还使用同步连接与磁盘夹具，不能用 SQLite 等价替代。

在 web 目录：

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test -- --run
npm.cmd run build
```

只改文档时先验证链接、代码路径、契约与 diff；若实际运行上述检查，报告实际结果。不要把文档中列出的命令误写成已经运行成功。

## 运行检查与排查

```powershell
Invoke-RestMethod http://localhost:1316/api/v1/health
Invoke-RestMethod http://localhost:1316/api/v1/projects
Invoke-WebRequest http://localhost:1317
```

health 只验证响应，不探测数据库。projects 成功可以补充证明该请求的数据访问；完整验收还需代表性导入、显示、编辑、分析和导出。

- 代理失败：检查 1316 后端、VITE_API_TARGET 与前端 /api 请求。
- 启动时数据库错误：worker 默认启动即执行恢复查询，先核对数据库与迁移。
- Python 地理库错误：检查 [geo_env.py](../backend/app/core/geo_env.py)与 [test_geo_env](../backend/tests/test_geo_env.py)，确认当前虚拟环境依赖。
- 任务取消仍完成：检查阶段边界，当前为合作式取消。
- 显示旧数据：检查 Layer 版本、后端瓦片缓存与实体写入链，见[架构边界](architecture.md#当前边界)。

性能测量另见[benchmarks](benchmarks.md)。本次文档重写没有执行数据库迁移、基准数据写入或部署。
