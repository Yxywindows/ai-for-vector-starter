# 04 要素与属性读取

本章描述 GeoJSON 要素读取与属性表分页的当前接口。导航见[文档目录](../README.md)。

## GeoJSON 要素

GET /api/v1/layers/{layer_id}/features 要求 bbox 为 EPSG:4326 的 minx,miny,maxx,maxy。服务端对请求范围和输出数量做校验；默认上限由配置控制（当前默认 2000），超过上限的显式请求会返回参数错误，而不是悄悄扩大响应。

[feature_repository.py](../../backend/app/repositories/feature_repository.py) 先按源几何范围筛选并按 ID 排序，最多读取 limit+1 条判断是否截断，然后转换、可选拓扑保持简化并序列化为 GeoJSON。响应包含 returned、limit、truncated。简化容差以经纬度表示；点图层由服务层跳过简化。bbox 解析与服务逻辑见 [feature_service.py](../../backend/app/services/feature_service.py)。

当前接口生成的 ETag 由 Layer 更新时间和查询参数构成，而不是源表行版本。外部数据变更若未更新图层元数据，ETag 并不能证明要素内容未变。浏览器的 [featureLoader.ts](../../web/src/map/featureLoader.ts) 会按视图加载 bbox、取消过期请求并将要素投影到地图坐标；当前加载器没有接入条件 ETag 请求，也没有使用 [geoCache](../../web/src/cache/geoCache.ts) 持久缓存。

## 属性表

GET /api/v1/layers/{layer_id}/attributes 提供分页、排序和过滤；页大小受服务端上限约束，字段和操作符需通过属性白名单校验。大表未过滤时，计数路径可使用 PostgreSQL 估算值并标记 totalEstimated；筛选计数走精确结果。它与地图上的 GeoJSON/MVT 加载是独立请求。

前端 [loadingTiers.ts](../../web/src/map/loadingTiers.ts) 按已有 featureCount 选择小图层全量 GeoJSON、中型图层 bbox GeoJSON、大型图层 MVT；阈值是当前客户端策略，不是服务端性能承诺。详细 MVT 行为见[第 05 章](05-vector-tiles-mvt.md)。

## 代码与测试

- 接口/查询：[features.py](../../backend/app/api/v1/routes/features.py)、[feature_service.py](../../backend/app/services/feature_service.py)、[feature_repository.py](../../backend/app/repositories/feature_repository.py)、[attribute_service.py](../../backend/app/services/attribute_service.py)
- 前端：[featureLoader.ts](../../web/src/map/featureLoader.ts)、[loadingTiers.ts](../../web/src/map/loadingTiers.ts)
- 测试：[test_features_api.py](../../backend/tests/test_features_api.py)、[test_bbox_parsing.py](../../backend/tests/test_bbox_parsing.py)、[test_attributes_api.py](../../backend/tests/test_attributes_api.py)、[featureLoader.test.ts](../../web/src/map/featureLoader.test.ts)
