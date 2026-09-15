# 05 矢量瓦片（MVT）

导航见[文档目录](../README.md)。本章只描述现有 PostGIS MVT 路径，不推导未实现的泛化或性能保证。

## 请求与生成

GET /api/v1/layers/{layer_id}/tiles/{z}/{x}/{y}.mvt 校验 XYZ 坐标范围。服务端用 ST_TileEnvelope 构造 Web Mercator tile，再用 ST_AsMVTGeom 裁剪/量化几何，并通过 ST_AsMVT 编码；属性列来自请求图层的已知字段。它不是 GeoJSON 编辑载体，也没有独立的几何简化步骤。空瓦片返回 204；有内容时返回 MVT MIME 类型。

OpenLayers [layerFactory.ts](../../web/src/map/layerFactory.ts) 对 featureCount 大于 50000 的 PostGIS 图层选择 MVT，并将其设为不可编辑。该阈值是前端分流策略。

## 缓存与新鲜度

[tile_service.py](../../backend/app/services/tile_service.py) 在进程内使用有界字节 LRU 缓存 MVT 字节；容量由配置控制。缓存键和 ETag 依赖 Layer 的更新时间及 z/x/y，HTTP 响应允许短期公共缓存。每个进程拥有自己的内存缓存。

图层元数据更新时间可使相应条目失效；直接改动源表要素并不必然更新 Layer.updated_at。因此缓存/ETag 不代表对外部数据写入具有完整版本感知，尤其不能据此承诺修改后立即跨进程一致。当前前端直接使用瓦片 URL，不应把尚未接入的浏览器 geoCache 视为 MVT 请求缓存。

## 代码与测试

- API/编码：[tiles.py](../../backend/app/api/v1/routes/tiles.py)、[tile_service.py](../../backend/app/services/tile_service.py)、[tile_repository.py](../../backend/app/repositories/tile_repository.py)
- 前端：[layerFactory.ts](../../web/src/map/layerFactory.ts)、[loadingTiers.ts](../../web/src/map/loadingTiers.ts)
- 测试：[test_vector_tiles_api.py](../../backend/tests/test_vector_tiles_api.py)、[test_tile_coords.py](../../backend/tests/test_tile_coords.py)、[test_perf_fastpath.py](../../backend/tests/test_perf_fastpath.py)、[layerFactory.test.ts](../../web/src/map/layerFactory.test.ts)
