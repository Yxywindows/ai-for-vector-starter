# 后端代码入口

本目录是 GIS Platform 的 FastAPI、SQLAlchemy 与 PostGIS 后端。HTTP 路由在 app/api/v1/routes，接口模型在 app/schemas，业务流程在 app/services，ORM 元数据在 app/models，数据库查询在 app/repositories。服务启动和数据库配置从 [app/main.py](app/main.py)、[app/core/config.py](app/core/config.py) 与 [app/db/session.py](app/db/session.py) 进入。

## 给 AI 的阅读顺序

1. 先看[后端架构与业务代码地图](../docs/reference/backend.md)，确认项目、图层、源数据、任务、导入导出与数据生命周期之间的关系。
2. 再看[后端 API 清单](../docs/reference/api.md)，按实际注册的 HTTP 方法、路径、字段别名和响应边界定位接口。
3. 按地图中的业务链阅读 route → schema → service/handler → repository/model → test；不要只凭路由名推断实现能力。
4. 涉及空间查询、矢量瓦片、栅格 COG、内存或编辑事务时，补读对应的[学习文档](../docs/learning/01-architecture-overview.md)至[09-editing-and-transactions.md](../docs/learning/09-editing-and-transactions.md)。

## 关键入口

| 关注点 | 源码 |
|---|---|
| 应用工厂、CORS、异常处理、lifespan、后台 worker 和栅格句柄池 | [app/main.py](app/main.py) |
| 路由总装与 /api/v1 前缀 | [app/api/v1/router.py](app/api/v1/router.py) |
| 环境配置 | [app/core/config.py](app/core/config.py) |
| 请求级异步事务 | [app/db/session.py](app/db/session.py) |
| 统一错误 JSON | [app/core/errors.py](app/core/errors.py) |
| 项目、图层、任务 ORM | [app/models](app/models) |
| 异步任务状态机与 worker | [app/services/task_lifecycle.py](app/services/task_lifecycle.py)、[app/services/task_worker.py](app/services/task_worker.py) |
| Alembic schema 边界 | [migrations/env.py](migrations/env.py) |
| 后端测试 | [tests](tests) |

接口默认挂载在 /api/v1；GIS_API_PREFIX 可覆盖该前缀，/health 还会以无版本前缀单独注册。仓库级启动、迁移和测试命令见[根 README](../README.md)。

后端测试连真实 PostGIS 测试库。测试配置会拒绝数据库 URL 末尾不是 gis_platform_test 的环境；任务 worker 在测试中关闭，再由测试直接调用 task_worker.run_once。测试夹具用外层事务回滚隔离用例，文件系统副作用则由各自夹具清理。参见 [tests/conftest.py](tests/conftest.py)、[tests/test_tasks.py](tests/test_tasks.py) 和 [tests/test_session.py](tests/test_session.py)。
