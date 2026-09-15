# 09 编辑、任务与事务边界

导航见[文档目录](../README.md)。本章把单个 API 请求、后台任务、导入外部产物和浏览器编辑队列分开描述；它们不是一个统一的大事务。

## 要素编辑

[edit_service.py](../../backend/app/services/edit_service.py) 只允许写 PostGIS 来源。它根据目录字段元数据选择可编辑属性，并排除 ID/几何列；几何输入按 GeoJSON/EPSG:4326 校验，再转换到数据源 SRID。写操作按 ID 定位并返回写后要素。注册表检查 ID 列存在，但不保证其唯一性；更新条件中也未观察到版本号/乐观锁，因此并发编辑冲突没有由 API 契约自动检测。

浏览器 [editSession.ts（EditQueue）](../../web/src/features/editing/editSession.ts) 合并同一要素的待处理操作，随后逐项顺序发送 create/update/delete 请求。每个成功请求由自己的 SessionDep 请求事务提交；整批 flush 不是一个服务器事务，若中途失败，之前成功项已提交，未成功的操作继续留在队列。当前编辑会话主要提交几何修改，新建时属性为空对象。

## 事务与补偿清理

| 路径 | 当前提交边界 |
| --- | --- |
| 常规 API 写请求 | SessionDep 在请求成功后提交；异常回滚。 |
| 后台任务 | worker 认领、进度和结果通过显式提交保存；进度提交用于让轮询端看到状态。 |
| 矢量导入 | GeoPandas 经独立同步引擎写数据表/索引，再登记 Layer 元数据；失败时尝试删除已写表，不是一个原子事务。 |
| 栅格导入 | 先写文件，再登记图层元数据；异常时尝试删除文件，不是数据库与文件系统原子提交。 |

异步任务由 [task_worker.py](../../backend/app/services/task_worker.py) 执行；启动恢复会把所有 running/cancelling 记录标成 failed 并提交。任务认领使用数据库锁并不意味着当前启动恢复逻辑支持多 worker/多进程安全运行。取消通过任务执行中的检查点协作处理，不等于对任意外部副作用自动撤销。

删除 Project 只级联其图层和任务元数据，物理数据清理另见[第 02 章](02-spatial-data-model.md)。

## 代码与测试

- 编辑/API：[edit_service.py](../../backend/app/services/edit_service.py)、[features.py](../../backend/app/api/v1/routes/features.py)、[editSession.ts（EditQueue）](../../web/src/features/editing/editSession.ts)
- 会话/任务：[session.py](../../backend/app/db/session.py)、[task_worker.py](../../backend/app/services/task_worker.py)、[task_lifecycle.py](../../backend/app/services/task_lifecycle.py)
- 导入：[vector_import_service.py](../../backend/app/services/vector_import_service.py)、[raster_import_service.py](../../backend/app/services/raster_import_service.py)
- 测试：[test_session.py](../../backend/tests/test_session.py)、[test_editing_api.py](../../backend/tests/test_editing_api.py)、[test_tasks.py](../../backend/tests/test_tasks.py)、[test_vector_import.py](../../backend/tests/test_vector_import.py)、[test_raster_import.py](../../backend/tests/test_raster_import.py)、[editSession.test.ts](../../web/src/features/editing/editSession.test.ts)
