# 06 栅格导入与切片

导航见[文档目录](../README.md)。本章区分栅格文件落盘、图层元数据和 PNG 瓦片读取。

## 导入

[raster_import_service.py](../../backend/app/services/raster_import_service.py) 接受 TIFF/COG、VRT、IMG、JP2 等受支持格式，检查 CRS、范围和统计信息；输入不是有效 COG 时尝试转换，再把栅格文件放入配置的 raster 目录。Layer.source 保存相对路径，而不是文件内容。路径解析会约束在 raster 目录内，避免从 API 路径跳出该目录。

文件写入和 Layer 元数据不是一个跨文件系统事务：服务在异常路径尝试清理已创建文件，但不能据此宣称数据库与磁盘具有分布式原子提交。项目删除也不负责删除栅格文件，见[第 02 章](02-spatial-data-model.md)。

## PNG 瓦片

GET /api/v1/layers/{layer_id}/tiles/{z}/{x}/{y}.png 由 [raster_tile_service.py](../../backend/app/services/raster_tile_service.py) 读取对应文件/波段，按 style 中支持的 bands、rescale、colormap 生成 PNG；瓦片覆盖范围外返回空响应。RasterStyle schema 还包含 opacity，但当前栅格读取路径没有应用该字段；图层透明度由 OpenLayers 图层配置单独处理。不要将 schema 中存在的字段自动等同为完整 UI/渲染行为。

打开文件和读取瓦片通过 [DatasetPool](../../backend/app/resources/dataset_pool.py) 管理，限制并发使用与空闲资源；具体行为见[第 07 章](07-memory-management.md)。

## 代码与测试

- 导入/读取：[raster_import_service.py](../../backend/app/services/raster_import_service.py)、[raster_tile_service.py](../../backend/app/services/raster_tile_service.py)
- 前端：[layerFactory.ts](../../web/src/map/layerFactory.ts)
- 测试：[test_raster_import.py](../../backend/tests/test_raster_import.py)、[test_raster_tiles_api.py](../../backend/tests/test_raster_tiles_api.py)、[layerFactory.test.ts](../../web/src/map/layerFactory.test.ts)
