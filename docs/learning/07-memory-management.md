# 07 缓存与内存边界

导航见[文档目录](../README.md)。这里按实际接入点区分后端缓存、数据集池和浏览器图层预算。

## 后端

- [DatasetPool](../../backend/app/resources/dataset_pool.py) 当前供 Rasterio Reader 复用，限制打开资源数和空闲时间；同一资源键的访问受锁保护。它不是通用矢量查询缓存。
- [source_snapshot.py](../../backend/app/services/source_snapshot.py) 缓存已验证的来源/列元数据，不缓存要素或 GeoJSON。
- [tile_service.py](../../backend/app/services/tile_service.py) 对 MVT 字节使用按容量限制的进程内 LRU。不同进程的缓存彼此独立。
- 服务端配置还约束要素数量和属性页大小，见 [config.py](../../backend/app/core/config.py)。

## 浏览器

[LayerMemoryManager.ts](../../web/src/map/memory/LayerMemoryManager.ts) 按图层估算占用并执行淘汰。GeoJSON 依据 JSON.stringify 字符长度估算，不等于浏览器堆内存或精确 UTF-8 大小；瓦片则由请求 instrumentation 记录字节数。选中图层会被固定，超预算的单个最新图层可能保留，因此预算不是硬性进程内存上限。地图工作区退出时清理管理器追踪的图层资源。

[geoCache.ts](../../web/src/cache/geoCache.ts)、[idb.ts](../../web/src/cache/idb.ts) 和 keys 模块有独立实现及测试，但目前不在 live featureLoader/layerFactory 加载路径中。不要把它们描述为地图当前启用的 IndexedDB 功能缓存。系统内存接口显示后端 RSS/栅格池等信息，不是浏览器堆快照。

## 代码与测试

- 后端：[dataset_pool.py](../../backend/app/resources/dataset_pool.py)、[source_snapshot.py](../../backend/app/services/source_snapshot.py)、[tile_service.py](../../backend/app/services/tile_service.py)、[system_service.py](../../backend/app/services/system_service.py)
- 浏览器：[LayerMemoryManager.ts](../../web/src/map/memory/LayerMemoryManager.ts)、[instrumentation.ts](../../web/src/map/memory/instrumentation.ts)、[useLayerMemory.ts](../../web/src/map/memory/useLayerMemory.ts)
- 测试：[LayerMemoryManager.test.ts](../../web/src/map/memory/LayerMemoryManager.test.ts)、[geoCache.test.ts](../../web/src/cache/geoCache.test.ts)、[idb.test.ts](../../web/src/cache/idb.test.ts)、[test_system_api.py](../../backend/tests/test_system_api.py)
