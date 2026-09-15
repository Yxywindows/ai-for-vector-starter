# 01 系统架构与请求生命周期

本文按当前代码说明 GIS 应用的启动、API 和前端地图边界；导航见[文档目录](../README.md)，项目入口见[根 README](../../README.md)。

## 启动与请求

FastAPI 应用由 [main.py](../../backend/app/main.py) 创建，API 路由集中挂载在 [router.py](../../backend/app/api/v1/router.py)，涵盖项目、图层、目录、导入、要素、瓦片、任务、分析、导出和系统接口。启动生命周期准备栅格/临时目录，创建 Rasterio 数据集池；启用任务 worker 时恢复遗留任务并启动进程内 worker，退出时停止 worker、关闭数据集池。

[SessionDep](../../backend/app/db/session.py) 为请求提供 AsyncSession：正常结束时提交，异常时回滚；依赖使用 function scope，在响应返回前完成收尾。请求级数据库事务不意味着文件写入、同步导入引擎或整批前端操作也在同一个事务中，详见[第 09 章](09-editing-and-transactions.md)。

接口错误由 [errors.py](../../backend/app/core/errors.py) 统一转换为包含 code、message、details 的 JSON 错误结构；配置项集中在 [config.py](../../backend/app/core/config.py)。

## Web 与地图

Web 端通过 [client.ts](../../web/src/api/client.ts) 请求 API，由 [router.tsx](../../web/src/app/router.tsx) 组织页面；地图的数据加载和图层创建分别见 [featureLoader.ts](../../web/src/map/featureLoader.ts) 与 [layerFactory.ts](../../web/src/map/layerFactory.ts)。

[WorkspaceSync.tsx](../../web/src/map/WorkspaceSync.tsx) 将当前地图视图同步到浏览器 URL。Project.view 有后端字段和 PATCH 接口，但当前前端没有调用 updateProject 的路径；因此不能把地图平移理解为自动保存到 Project.view。项目缩略图接口是另一条独立路径。

## 当前边界

- 任务 worker 是每个应用进程内的单 worker。启动恢复会把数据库中所有 running/cancelling 任务标记为 failed；这不等于可安全多进程部署。数据库领取任务时即使使用 SKIP LOCKED，也不能消除此启动恢复行为。
- 项目删除级联清理的是图层/任务元数据，不代表磁盘栅格、导入表或导出文件会一起删除，见[第 02 章](02-spatial-data-model.md)。
- 源码旁的测试说明局部契约，不是此文档执行过完整运行或部署验收的证明。

## 代码与测试

- 启动/API：[main.py](../../backend/app/main.py)、[router.py](../../backend/app/api/v1/router.py)、[session.py](../../backend/app/db/session.py)
- Web：[router.tsx](../../web/src/app/router.tsx)、[WorkspaceSync.tsx](../../web/src/map/WorkspaceSync.tsx)
- 测试：[test_session.py](../../backend/tests/test_session.py)、[test_tasks.py](../../backend/tests/test_tasks.py)、[test_system_api.py](../../backend/tests/test_system_api.py)
