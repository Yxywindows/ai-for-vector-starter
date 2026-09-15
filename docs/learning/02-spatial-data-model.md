# 02 空间数据模型

本文记录持久化模型、空间表与 API 契约。导航见[文档目录](../README.md)和[项目 README](../../README.md)。

## 元数据与空间数据

[Project](../../backend/app/models/project.py) 保存项目名称、JSONB 视图和时间戳，并关联多个 [Layer](../../backend/app/models/layer.py)。Layer 保存数据种类、来源、样式、可见性、透明度、顺序、范围、数量、SRID、几何类型及源文件名。Task 元数据见 [task.py](../../backend/app/models/task.py)：任务关联项目，图层删除时其 layer_id 可置空，项目删除则级联删除任务记录。

应用维护的元数据位于配置的 GIS schema；用户数据表由导入/目录注册路径管理，常见默认位置为 gis_data。两者不是同一张表。Alembic 的初始结构和后续字段/任务迁移见 [0001](../../backend/migrations/versions/0001_initial_schema.py)、[0002](../../backend/migrations/versions/0002_layer_source_filename.py)、[0003](../../backend/migrations/versions/0003_task_table.py)。[迁移环境](../../backend/migrations/env.py)管理 GIS 元数据模型，不会把运行时登记的每张用户数据表都当作 ORM 模型迁移。

## Source、Style 与 API 模型

[Source schema](../../backend/app/schemas/source.py) 使用 type 区分 PostGIS、栅格文件、XYZ 和 MVT 来源；[Style schema](../../backend/app/schemas/style.py) 将矢量和栅格样式分开。Layer 的读写 API schema 见 [layer.py](../../backend/app/schemas/layer.py)。目前 LayerRead 和前端 Layer 类型不公开 updated_at；后端内部仍会用模型时间戳生成部分缓存键/ETag，不能把它视为客户端可用的版本字段。

目录注册会检查表、几何列和指定 ID 列是否存在，并读取空间元数据；它没有证明指定 ID 列具备主键或唯一约束。因此，依赖 ID 定位单个要素的编辑操作需要调用方提供稳定且唯一的 ID。

## 删除语义

删除 Project 会级联删除相关 Layer 与 Task 元数据，但当前删除路径不删除底层 PostGIS 导入表、栅格文件、缩略图或导出产物。不要将数据库外键级联解释为物理数据清理。

## 代码与测试

- 模型：[project.py](../../backend/app/models/project.py)、[layer.py](../../backend/app/models/layer.py)、[task.py](../../backend/app/models/task.py)
- API schema：[source.py](../../backend/app/schemas/source.py)、[style.py](../../backend/app/schemas/style.py)、[layer.py](../../backend/app/schemas/layer.py)
- 注册与迁移：[catalog_service.py](../../backend/app/services/catalog_service.py)、[env.py](../../backend/migrations/env.py)
- 测试：[test_models.py](../../backend/tests/test_models.py)、[test_layers_api.py](../../backend/tests/test_layers_api.py)、[test_projects_api.py](../../backend/tests/test_projects_api.py)、[test_catalog_api.py](../../backend/tests/test_catalog_api.py)、[test_alembic_env.py](../../backend/tests/test_alembic_env.py)
