# 03 PostGIS 与动态 SQL

本章说明动态表/列名与用户值分别如何进入查询。导航见[文档目录](../README.md)。

## 标识符与值

SQL 参数绑定适用于值，不能代替标识符处理。应用将两类路径区分开：

- 新建/用户提交的 schema、表、几何列、ID 列等受 [identifiers.py](../../backend/app/db/identifiers.py) 的严格标识符规则约束，再按 PostgreSQL 规则引用。
- 已存在的目录对象名来自数据库元数据；查询时通过安全引用逻辑转义双引号。GeoJSON 属性名可能不是普通业务标识符，不能假设它们都满足新建对象的命名规则。

属性过滤的操作符是 schema 中的有限集合；[attribute_service.py](../../backend/app/services/attribute_service.py) 校验请求字段和排序字段属于可用属性，并绑定过滤值。[catalog_service.py](../../backend/app/services/catalog_service.py) 在注册时验证目标表、几何列和 ID 列存在。注册检查不等于证明 ID 唯一。

## 空间查询与元数据快照

要素查询、MVT 查询会把 bbox/tile 范围变换到源数据 SRID 后使用 PostGIS 空间谓词；几何输出再按接口需要转换。相关 SQL 位于 [feature_repository.py](../../backend/app/repositories/feature_repository.py) 和 [tile_repository.py](../../backend/app/repositories/tile_repository.py)。

[SourceSnapshot](../../backend/app/services/source_snapshot.py) 是进程内有界缓存，保存经验证的来源和列元数据，不缓存要素行。缓存键包含图层 ID 与图层更新时间；如果外部直接修改表结构而没有更新图层元数据，已有快照会继续复用，直到 LRU 逐出、显式 invalidate/clear 或图层版本变化；此缓存没有 TTL。外部 DDL 与应用缓存并没有自动协调协议。

## 代码与测试

- 标识符规则：[identifiers.py](../../backend/app/db/identifiers.py)
- 动态元数据：[catalog_service.py](../../backend/app/services/catalog_service.py)、[catalog_repository.py](../../backend/app/repositories/catalog_repository.py)、[source_snapshot.py](../../backend/app/services/source_snapshot.py)
- 查询：[feature_repository.py](../../backend/app/repositories/feature_repository.py)、[tile_repository.py](../../backend/app/repositories/tile_repository.py)
- 测试：[test_identifiers.py](../../backend/tests/test_identifiers.py)、[test_catalog_api.py](../../backend/tests/test_catalog_api.py)、[test_attributes_api.py](../../backend/tests/test_attributes_api.py)、[test_features_api.py](../../backend/tests/test_features_api.py)
