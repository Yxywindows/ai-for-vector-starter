# 08 样式与渲染

导航见[文档目录](../README.md)。样式 JSON 是后端验证的持久化契约，但矢量与栅格由不同路径解释。

## 样式结构与编辑

[style.py](../../backend/app/schemas/style.py) 定义带 kind 判别字段的 VectorStyle / RasterStyle。矢量支持 single、categorized、graduated renderer，以及填充、描边、点标记和标签；栅格字段包括 bands、rescale、colormap、opacity。空对象表示尚无保存样式。

[StyleEditor.tsx](../../web/src/features/styling/StyleEditor.tsx) 编辑本地草稿，点击应用后通过图层 PATCH 保存；未应用的输入不会自动成为服务端图层状态。分类编辑器基于当前可见字段/取样数据构造分类：分类值数量有限，渐变界面当前生成固定数量的等距断点。schema 虽允许 quantile、natural_breaks，但 UI 当前没有对应分类算法入口。

## 渲染路径

[styleCompiler.ts](../../web/src/map/styleCompiler.ts) 把矢量样式编译为 OpenLayers 样式，分类比较和区间边界以客户端实现为准；矢量与矢量瓦片由客户端渲染。栅格样式则由后端 PNG 瓦片服务读取波段、拉伸和色带。Layer 自身 opacity 另由 OpenLayers 应用；schema 的 RasterStyle.opacity 当前未在该瓦片路径消费。

样式编辑器分类用到属性数据，需留意属性分页上限，而不是假定会对任意大表取完所有值。当前 UI/算法细节以代码为准，不应把 schema 支持的选项都写成已实现交互。

## 代码与测试

- 契约：[style.py](../../backend/app/schemas/style.py)
- UI/编译：[StyleEditor.tsx](../../web/src/features/styling/StyleEditor.tsx)、[styleCompiler.ts](../../web/src/map/styleCompiler.ts)、[layerFactory.ts](../../web/src/map/layerFactory.ts)
- 测试：[test_schemas.py](../../backend/tests/test_schemas.py)、[StyleEditor.test.tsx](../../web/src/features/styling/StyleEditor.test.tsx)、[styleCompiler.test.ts](../../web/src/map/styleCompiler.test.ts)、[layerFactory.test.ts](../../web/src/map/layerFactory.test.ts)
