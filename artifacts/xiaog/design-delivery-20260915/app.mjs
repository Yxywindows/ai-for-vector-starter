import { esc, extentText, mapSVG } from "./map.mjs";
export const FEATURES = [
  {
    id: "projects",
    title: "项目空间",
    normal: [0, 0, 1],
    copy: "把图层放回它所在的空间。先选项目，再看看它的范围与数据。",
    dialogue: "每一个项目，都有自己的空间。",
  },
  {
    id: "data",
    title: "数据资源",
    normal: [1, 0, 0],
    copy: "从目录走近一层数据。字段、来源和空间范围，都在同一处。",
    dialogue: "先看看数据从哪里来，再决定怎样使用。",
  },
  {
    id: "analysis",
    title: "空间分析",
    normal: [0, 0, -1],
    copy: "让图层之间的关系清楚起来。从输入、方法和一个明确的参数开始。",
    dialogue: "先选一种分析方法，再确认它需要的图层和参数。",
  },
  {
    id: "tasks",
    title: "任务进度",
    normal: [-1, 0, 0],
    copy: "沿着时间查看每次作业。状态、日志与关联对象，都有迹可循。",
    dialogue: "任务走到哪一步，可以在这里找到。",
  },
  {
    id: "exports",
    title: "导出交付",
    normal: [0, 1, 0],
    copy: "带走你需要的数据。选择图层，确认格式、坐标系和保留的字段。",
    dialogue: "交付前，先确认格式和坐标系。",
  },
  {
    id: "overview",
    title: "平台概览",
    normal: [0, -1, 0],
    copy: "退一步看全局。从近期项目、数据和作业，找到下一步的入口。",
    dialogue: "这里可以看见所有项目的联系。",
  },
];
const TOOLS = [
  ["buffer", "缓冲区", "按米设置边界向外扩展的距离。", "先选输入图层，再设置缓冲距离（米），看看周边的影响范围。"],
  ["clip", "裁剪", "保留输入图层位于掩膜内的部分。", "选好输入图层和掩膜图层，保留掩膜范围内的部分。"],
  ["intersection", "相交", "计算两层数据的空间重叠。", "选择两层数据，看看它们在空间上重叠的部分。"],
  ["dissolve", "融合", "按字段合并几何，留空则融合全部。", "按共同字段融合要素；选择“融合全部”，就不再按字段分组。"],
  ["spatial-join", "空间连接", "按空间关系连接另一层的属性。", "先选目标图层和关联图层，再用相交、包含或位于内部来匹配属性。"],
  ["validate-repair", "几何修复", "检查并修复无效几何。", "选好输入图层，我们来检查并修复无效几何。"],
  ["point-in-polygon", "面内点计数", "统计每个面内的点数量。", "先选点图层和多边形图层，统计每个面内有多少个点。"],
];
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const emptySnapshot = {
  projects: [],
  geometry: {},
  fields: {},
  tasks: [],
  tables: [],
  logs: {},
  capturedAt: null,
};
let snapshot,
  scene = null,
  sceneFailed = false,
  noticeTimer,
  transitionTimer;
try {
  const response = await fetch("./data/snapshot.json");
  if (!response.ok) throw Error("snapshot");
  snapshot = await response.json();
} catch {
  snapshot = emptySnapshot;
  $("#model-state").textContent =
    "资料暂时无法读取，可重新打开或查看设计入口。";
}
const layers = () => snapshot.projects.flatMap((p) => p.layers);
const state = {
  mode: "home",
  feature: null,
  projectId: "",
  layerId: "",
  taskId: "",
  tool: "buffer",
  secondary: "",
  distance: "500",
  outputName: "",
  byField: "",
  predicate: "intersects",
  format: "geojson",
  crs: "4326",
  filename: "",
  excluded: new Set(),
  projectSearch: "",
  dataSearch: "",
  kind: "",
  taskState: "",
  taskType: "",
  dataKey: "",
  reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  transitionId: 0,
};
const project = () => snapshot.projects.find((p) => p.id === state.projectId);
const layer = () =>
  layers().find(
    (l) =>
      l.id === state.layerId &&
      (!state.projectId || l.projectId === state.projectId),
  );
const vecLayers = () =>
  (project()?.layers ?? []).filter(
    (l) => l.kind === "vector" && l.source.type === "postgis",
  );
const exportLayers = () =>
  (project()?.layers ?? []).filter(
    (l) =>
      (l.kind === "vector" && l.source.type === "postgis") ||
      l.kind === "raster",
  );
const feature = () => FEATURES.find((f) => f.id === state.feature);
const statusText = (s) =>
  ({
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    running: "进行中",
    queued: "等待中",
    cancelling: "正在取消",
  })[s] ?? s;
const statusTag = (s) =>
  `<span class="tag ${s === "failed" ? "error" : ["cancelled", "queued"].includes(s) ? "muted" : ""}">${esc(statusText(s))}</span>`;
const count = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US"));
function inform(text) {
  $("#notice").textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("#notice").textContent = ""), 5500);
}
function routePath(mode = state.mode, id = state.feature) {
  return mode === "home"
    ? "home"
    : mode === "preview" || mode === "expanding"
      ? "preview/" + id
      : id;
}
function url(mode = state.mode, id = state.feature) {
  const params = new URLSearchParams();
  if (state.projectId) params.set("projectId", state.projectId);
  if (state.layerId) params.set("layerId", state.layerId);
  if (state.taskId && id === "tasks") params.set("taskId", state.taskId);
  return "#/" + routePath(mode, id) + (params.size ? "?" + params : "");
}
function writeRoute(replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", url());
}
function validateContext(params) {
  const requested = params.get("projectId") ?? "";
  state.projectId = snapshot.projects.some((p) => p.id === requested)
    ? requested
    : "";
  if (requested && !state.projectId)
    inform("这个项目不在当前资料中，请重新选择。");
  const requestedLayer = params.get("layerId") ?? "";
  const found = layers().find((l) => l.id === requestedLayer);
  state.layerId =
    found && (!state.projectId || found.projectId === state.projectId)
      ? requestedLayer
      : "";
  if (requestedLayer && !state.layerId)
    inform("图层不存在或不属于当前项目，已清除图层选择。");
  state.taskId = snapshot.tasks.some((t) => t.id === params.get("taskId"))
    ? params.get("taskId")
    : "";
  if (params.get("taskId") && !state.taskId)
    inform("未找到这条任务，仍可查看任务列表。");
  state.secondary = "";
}
function restore() {
  clearTimeout(transitionTimer);
  state.transitionId++;
  const [path, query = ""] = (
    location.hash.replace(/^#\//, "") || "home"
  ).split("?");
  const bits = path.split("/");
  validateContext(new URLSearchParams(query));
  state.mode =
    bits[0] === "home" ? "home" : bits[0] === "preview" ? "preview" : "work";
  state.feature =
    bits[0] === "preview" ? bits[1] : state.mode === "work" ? bits[0] : null;
  if (state.feature && !FEATURES.some((f) => f.id === state.feature)) {
    state.feature = null;
    state.mode = "home";
    inform("没有找到这个页面，已回到观测室。");
  }
  renderAll();
  scene?.setContext(snapshot, layer());
  scene?.setState(state, true);
  if (state.mode === "work")
    $("#workspace-title").focus({ preventScroll: true });
}
function nav(id) {
  clearTimeout(transitionTimer);
  state.transitionId++;
  const quick = state.mode === "work";
  state.feature = id;
  state.mode = quick ? "work" : "preview";
  writeRoute();
  renderAll();
  scene?.setState(state, false);
  if (quick) {
    $("#workspace-body").animate(
      [
        { opacity: 0.6, transform: "translateY(4px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: state.reduced ? 0 : 160 },
    );
    $("#workspace-title").focus({ preventScroll: true });
  } else inform("已选择" + feature().title + "。");
  $("#navigation").classList.remove("open");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
}
function expand() {
  if (state.mode !== "preview") return;
  state.mode = "expanding";
  const id = ++state.transitionId;
  scene?.setState(state, false);
  if (state.reduced || sceneFailed) return finishExpand(id);
  transitionTimer = setTimeout(() => finishExpand(id), 560);
}
function finishExpand(id) {
  if (id !== state.transitionId || state.mode !== "expanding") return;
  state.mode = "work";
  writeRoute();
  renderAll();
  scene?.setState(state, true);
  $("#workspace-title").focus({ preventScroll: true });
  scrollTo(0, 0);
}
function home() {
  clearTimeout(transitionTimer);
  const previous = state.feature;
  state.transitionId++;
  state.mode = "home";
  state.feature = null;
  writeRoute();
  renderAll();
  scene?.setState(state, false);
  $(`#navigation a[data-feature="${previous}"]`)?.focus();
  scrollTo(0, 0);
}
function options(items, value, placeholder = "请选择图层") {
  return (
    `<option value="">${placeholder}</option>` +
    items
      .map(
        (x) =>
          `<option value="${esc(x.id)}" ${value === x.id ? "selected" : ""}>${esc(x.name)}</option>`,
      )
      .join("")
  );
}
function contextOptions() {
  const all = ["tasks", "overview", "data"].includes(state.feature);
  return options(
    snapshot.projects,
    state.projectId,
    all ? "全部项目" : "选择项目",
  );
}
function setProject(id) {
  state.projectId = id;
  state.layerId = "";
  state.secondary = "";
  state.taskId = "";
  state.dataKey = "";
  state.excluded.clear();
  writeRoute(true);
  renderAll();
  scene?.setContext(snapshot, layer());
  inform(
    id
      ? "工作项目已切换到 " + project().name + "，请选择输入图层。"
      : "已切换到全部或未选择项目。",
  );
}
function setLayer(id) {
  state.layerId = id;
  state.excluded.clear();
  writeRoute(true);
  scene?.setContext(snapshot, layer());
}
function mapPanel(l = layer(), title = "当前空间范围") {
  const sampled = snapshot.geometry[l?.id];
  return `<div class="map-panel"><div class="map-title"><span>${esc(title)}</span><span class="mono">${l?.srid ? "EPSG:" + esc(l.srid) : "范围未就绪"}</span></div>${mapSVG(snapshot, l)}<div class="map-legend"><span><span class="dot-blue"></span>${sampled ? "城市边界 · " + sampled.data.features.length + " 个局部要素" : "图层范围示意"}</span><span>${sampled ? "简化几何 · 非测量地图" : "未显示要素几何"}</span></div></div>`;
}
function sectionTitle(title, meta = "") {
  return `<div class="section-title"><h2>${title}</h2><span>${meta}</span></div>`;
}
function refreshFallback() {
  const img = $("#fallback");
  img.classList.toggle("scene-still", state.mode !== "work");
  img.src =
    state.mode === "work"
      ? "./assets/avatar.png"
      : innerWidth <= 700
        ? "./assets/static-scene-mobile.png"
        : "./assets/static-scene-desktop.png";
}
addEventListener("resize", refreshFallback);
function renderDialogue() {
  const method = state.feature === "analysis"
    ? TOOLS.find((tool) => tool[0] === state.tool)
    : null;
  $("#dialogue-text").textContent =
    method?.[3] ?? feature()?.dialogue ?? "你好。选一个方向，我们一起开始。";
}
function renderAll() {
  refreshFallback();
  document.body.dataset.mode = state.mode === "work" ? "work" : "home";
  document.body.classList.toggle(
    "previewing",
    ["preview", "expanding"].includes(state.mode),
  );
  $("#home").hidden = state.mode === "work";
  $("#workspace").hidden = state.mode !== "work";
  $("#projection").hidden = !["preview", "expanding"].includes(state.mode);
  $("#navigation").innerHTML = FEATURES.map(
    (f, i) =>
      `<a href="${url(state.mode === "work" ? "work" : "preview", f.id)}" data-feature="${f.id}" ${state.feature === f.id ? 'aria-current="page"' : ""}><span>0${i + 1}</span>${f.title}</a>`,
  ).join("");
  $("#home-project").innerHTML = contextOptions();
  $("#home-layer").innerHTML = options(
    project()?.layers ?? [],
    state.layerId,
    "选择观察图层",
  );
  $("#home-layer").disabled = !project();
  $("#work-project").innerHTML = contextOptions();
  $("#context-name").textContent = project()?.name ?? "全部空间";
  $("#scope-label").textContent = layer()?.extent
    ? "图层范围 " + extentText(layer().extent)
    : project()
      ? "请选择一层数据"
      : "尚未选择项目";
  $("#slice-caption").style.visibility = snapshot.geometry[layer()?.id]
    ? "visible"
    : "hidden";
  $("#dialogue").style.display = "";
  renderDialogue();
  $("#motion").setAttribute("aria-pressed", String(state.reduced));
  $("#motion").textContent = state.reduced ? "恢复动态" : "减少动态";
  if (feature()) {
    const f = feature();
    $("#preview-title").textContent = f.title;
    $("#preview-copy").textContent = f.copy;
    $("#preview-step").textContent =
      "0" + (FEATURES.indexOf(f) + 1) + " / 06 · 观察方向";
    $("#preview-source").textContent = document.body.classList.contains(
      "static-scene",
    )
      ? "观察方向 · " + f.title
      : "来自魔方 · " + f.title + "面";
    $("#preview-context").innerHTML =
      `<span>${esc(project()?.name ?? "全部项目")}</span><span>${esc(layer() ? count(layer().featureCount) + " 要素" : "选择图层后关联范围")}</span>`;
    $("#preview-map").innerHTML = layer()
      ? mapSVG(snapshot, layer(), 480, 150) +
        "<span>" +
        esc(layer().name) +
        " · " +
        (snapshot.geometry[layer().id] ? "局部输入范围" : "图层范围示意") +
        "</span>"
      : "<p>尚未选择观察图层，可在工作台选择输入。</p>";
    $("#workspace-title").textContent = f.title;
    $("#workspace-crumb").textContent =
      "空间观测室 / " + (project()?.name ?? "全部项目");
  }
  $("#source-stamp").textContent = snapshot.capturedAt
    ? "资料采集于 " +
      new Date(snapshot.capturedAt).toLocaleString("zh-CN", { hour12: false }) +
      " · 只读快照"
    : "资料读取失败";
  if (state.mode === "work") renderPage();
}
function renderPage() {
  const active = document.activeElement?.id;
  $("#workspace-body").innerHTML = (
    {
      projects: projectsPage,
      data: dataPage,
      analysis: analysisPage,
      tasks: tasksPage,
      exports: exportsPage,
      overview: overviewPage,
    }[state.feature] ?? projectsPage
  )();
  if (active && document.getElementById(active))
    document.getElementById(active).focus({ preventScroll: true });
}
function projectsPage() {
  const visible = snapshot.projects.filter((p) =>
    p.name.toLowerCase().includes(state.projectSearch.toLowerCase()),
  );
  const p = project(),
    l = layer() ?? p?.layers[0];
  return `<div class="toolbar"><input type="search" id="project-search" aria-label="搜索项目" placeholder="搜索项目" value="${esc(state.projectSearch)}"><span class="count">${visible.length} 个项目</span></div><div class="split"><section>${sectionTitle("我的项目", "选择后关联右侧范围")}${visible.map((p, i) => `<button class="project-row" data-project="${p.id}" aria-pressed="${p.id === state.projectId}"><span class="project-num">0${i + 1}</span><span><h3>${esc(p.name)}</h3><span class="hint">${p.layers.length} 层数据 · ${esc(p.layers[0]?.geometryType ?? "暂无数据")}</span></span><span class="arrow">↗</span></button>`).join("") || '<div class="empty">没有匹配的项目。试试其他名称。</div>'}<p class="hint" style="margin-top:25px">选择一个项目，再把数据与它的范围联系起来。</p><button class="text-button" data-demo="创建项目的名称与范围将在正式工作台设置。当前不会新建项目。">＋ 新建项目</button></section><section>${mapPanel(l, p?.name ?? "先选择项目")}<dl class="scope-stats"><div><dt>图层</dt><dd>${esc(l?.name ?? "尚未选择")}</dd></div><div><dt>要素总数</dt><dd>${count(l?.featureCount)}</dd></div><div><dt>范围 / EPSG:4326</dt><dd class="mono">${extentText(l?.extent)}</dd></div><div><dt>来源</dt><dd>${esc(l?.source?.type ?? "未找到")}</dd></div></dl><div class="scope-action"><button class="quiet" data-open-data="${l?.id ?? ""}" ${!l ? "disabled" : ""}>查看项目图层</button><button class="text-button" data-map="true" ${!p ? "disabled" : ""}>进入地图 ↗</button></div></section></div>`;
}
function catalogRows() {
  const bound = layers().map((l) => ({
    ...l,
    key: l.id,
    label: l.name,
    type: l.kind,
  }));
  const registered = new Set(
    layers()
      .filter((l) => l.source.type === "postgis")
      .map((l) => l.source.schemaName + "." + l.source.tableName),
  );
  return [
    ...bound,
    ...snapshot.tables
      .filter((t) => !registered.has(t.schemaName + "." + t.tableName))
      .map((t) => ({
        key: t.schemaName + "." + t.tableName,
        label: t.schemaName + "." + t.tableName,
        type: "table",
        geometryType: t.geometryType,
        featureCount: t.estimatedRows,
        projectId: null,
        srid: t.srid,
        source: t,
      })),
  ];
}
function dataPage() {
  const rows = catalogRows().filter(
    (r) =>
      (!state.projectId || !r.projectId || r.projectId === state.projectId) &&
      (!state.kind || r.type === state.kind) &&
      r.label.toLowerCase().includes(state.dataSearch.toLowerCase()),
  );
  const selected = rows.find((r) => r.key === (state.dataKey || state.layerId));
  const f = selected?.id ? snapshot.fields[selected.id]?.fields : [];
  return `<div class="toolbar"><input type="search" id="data-search" aria-label="搜索数据" placeholder="搜索图层或来源表" value="${esc(state.dataSearch)}"><select id="data-kind" aria-label="数据类型"><option value="">全部类型</option><option value="vector" ${state.kind === "vector" ? "selected" : ""}>矢量图层</option><option value="table" ${state.kind === "table" ? "selected" : ""}>未绑定表</option></select><span class="count">${rows.length} 项数据</span></div><div class="table-wrap"><table><thead><tr><th>数据名称</th><th>几何 / 类型</th><th>要素</th><th>所属项目</th></tr></thead><tbody>${rows.map((r) => `<tr class="${selected?.key === r.key ? "table-row-selected" : ""}"><td><button data-data="${esc(r.key)}">${esc(r.label)}</button></td><td><span class="mono">${esc(r.geometryType)}</span><br><span class="hint">${r.type === "table" ? "未绑定表" : "矢量图层"}</span></td><td class="mono">${count(r.featureCount)}</td><td>${esc(snapshot.projects.find((p) => p.id === r.projectId)?.name ?? "未绑定项目")}</td></tr>`).join("") || '<tr><td colspan="4" class="empty">没有匹配的数据，调整搜索或类型筛选。</td></tr>'}</tbody></table></div>${selected ? `<section class="detail-drawer"><div><p class="eyebrow">数据详情 / 来源与字段</p><h2>${esc(selected.label)}</h2><p class="source-path">${esc(selected.source.schemaName ?? "gis_data")}.${esc(selected.source.tableName ?? "")}<br>EPSG:${esc(selected.srid)} · ${selected.id ? "已绑定图层" : "独立表，尚未绑定图层"}</p>${f?.length ? `<div class="field-list">${f.map((x) => `<span>${esc(x.name)} <small>${esc(x.type ?? x.dataType ?? "")}</small></span>`).join("")}</div>` : '<p class="hint">未取得图层字段详情。</p>'}<p class="hint">${selected.id ? "字段来自当前图层元数据。属性值、样式编辑在正式地图工作区查看。" : "这张表没有图层 ID 与空间范围，不能定位到某个项目。"}</p>${selected.id ? `<button class="text-button" data-analyze="${selected.id}">使用此图层分析 ↗</button>` : ""}</div><div>${mapPanel(selected, selected.id ? "图层空间范围" : "未绑定空间范围")}</div></section>` : '<div class="empty">选择一项数据，查看字段、来源与空间范围。</div>'}`;
}
function analysisPage() {
  const t = TOOLS.find((t) => t[0] === state.tool),
    secondary = [
      "clip",
      "intersection",
      "spatial-join",
      "point-in-polygon",
    ].includes(state.tool);
  return `<div class="tool-strip" role="group" aria-label="分析方法">${TOOLS.map((t) => `<button data-tool="${t[0]}" aria-pressed="${state.tool === t[0]}">${t[1]}</button>`).join("")}</div><div class="split"><section><div class="form-title"><span>01 — 参数</span><h2>${t[1]}</h2></div><p class="hint">${t[2]}</p><form id="analysis-form" novalidate><div class="fields"><label>${state.tool === "point-in-polygon" ? "点图层" : state.tool === "spatial-join" ? "目标图层" : "输入图层"}<select id="analysis-layer">${options(vecLayers(), state.layerId)}</select></label>${secondary ? `<label>${state.tool === "clip" ? "掩膜图层" : state.tool === "point-in-polygon" ? "多边形图层" : "关联图层"}<select id="secondary">${options(vecLayers(), state.secondary)}</select></label>` : ""}${state.tool === "buffer" ? `<label>缓冲距离<div class="unit-input"><input id="distance" type="number" min="0.1" step="any" value="${esc(state.distance)}"><span>米</span></div></label>` : ""}${
    state.tool === "dissolve"
      ? `<label>融合字段（可选）<select id="by-field">${options(
          (snapshot.fields[state.layerId]?.fields ?? []).map((f) => ({
            id: f.name,
            name: f.name,
          })),
          state.byField,
          "融合全部",
        )}</select></label>`
      : ""
  }${state.tool === "spatial-join" ? `<label>空间关系<select id="predicate">${["intersects", "contains", "within"].map((x) => `<option ${state.predicate === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>` : ""}<label>输出数据名称<input id="output-name" value="${esc(state.outputName)}" placeholder="例如：城市边界_500米"></label></div><div class="form-actions"><button class="primary" type="submit">检查分析参数 <span>→</span></button><span class="hint">结果尚未生成</span></div><div id="analysis-feedback" class="feedback" role="status"></div></form></section><section>${mapPanel(layer(), "输入图层 · 局部观察窗")}<div class="flow"><span>输入图层</span> → <span>${t[1]}</span> → <span>等待结果</span></div><div class="result-empty"><span class="ring">—</span><div><h3>先确认输入，再运行分析</h3><p>当前只查看输入范围。没有运行新的分析，也没有生成结果图层。</p></div></div><button class="text-button" data-nav="tasks">查看历史作业 ↗</button></section></div>`;
}
function taskName(t) {
  return (
    t.result?.downloadName ??
    t.provenance?.outputName ??
    t.provenance?.sourceFilename ??
    {
      export_vector: "矢量导出",
      analysis_buffer: "缓冲区分析",
      vector_import: "矢量导入",
    }[t.kind] ??
    t.kind
  );
}
function tasksPage() {
  const tasks = snapshot.tasks.filter(
    (t) =>
      (!state.projectId || t.projectId === state.projectId) &&
      (!state.taskState || t.state === state.taskState) &&
      (!state.taskType || t.kind.startsWith(state.taskType)),
  );
  const selected = tasks.find((t) => t.id === state.taskId);
  return `<div class="toolbar"><select id="task-state" aria-label="任务状态">${[
    ["", "全部状态"],
    ["succeeded", "已完成"],
    ["failed", "失败"],
    ["cancelled", "已取消"],
    ["running", "进行中"],
  ]
    .map(
      ([v, t]) =>
        `<option value="${v}" ${state.taskState === v ? "selected" : ""}>${t}</option>`,
    )
    .join("")}</select><select id="task-type" aria-label="任务类型">${[
    ["", "全部类型"],
    ["analysis_", "空间分析"],
    ["export_", "导出"],
    ["vector_import", "导入"],
  ]
    .map(
      ([v, t]) =>
        `<option value="${v}" ${state.taskType === v ? "selected" : ""}>${t}</option>`,
    )
    .join(
      "",
    )}</select><span class="count">${tasks.length} 条历史记录</span></div><div class="task-split"><section>${sectionTitle("时间与作业", "历史状态 · 不实时更新")}${tasks.map((t) => `<button class="timeline-row" data-task="${t.id}" aria-pressed="${selected?.id === t.id}"><span class="date">${t.createdAt.slice(5, 10)}<br>${t.createdAt.slice(11, 16)} UTC</span><span><h3>${esc(taskName(t))}</h3><span class="hint">${esc(t.projectName)} · ${esc(t.kind)}</span></span>${statusTag(t.state)}</button>`).join("") || '<div class="empty">这个筛选下没有任务记录。</div>'}</section><section class="log-panel">${selected ? `<p class="eyebrow">作业详情 / 关联对象</p><h2>${esc(taskName(selected))}</h2><div class="task-id">${selected.id}</div>${statusTag(selected.state)}<p class="hint" style="margin-top:15px">${esc(selected.projectName)} · ${selected.durationMs == null ? "耗时未记录" : selected.durationMs + " ms"}</p>${selected.error ? `<p class="feedback error">${esc(selected.error.code)}<br>${esc(selected.error.message)}</p>` : ""}<div class="log-lines">${(snapshot.logs[selected.id] ?? []).map((l) => `<div><span class="muted">${esc(l.level)} / </span>${esc(l.message)}</div>`).join("") || "未保存这条任务的日志快照。"}</div>${selected.layerId && layers().some((l) => l.id === selected.layerId) ? `<button class="text-button" data-open-data="${selected.layerId}">查看关联图层 ↗</button>` : selected.result?.layerId ? '<p class="hint">历史结果 ID 已记录；当前图层列表中未找到该结果，无法定位。</p>' : '<p class="hint">这条记录没有可定位的图层。</p>'}` : '<div class="empty">选择一条作业，<br>查看它的日志与关联对象。</div>'}</section></div>`;
}
function exportsPage() {
  const l = layer(),
    raster = l?.kind === "raster",
    fields = snapshot.fields[l?.id]?.fields ?? [],
    exports = snapshot.tasks.filter(
      (t) =>
        t.kind.startsWith("export_") &&
        (!state.projectId || t.projectId === state.projectId),
    );
  return `<div class="split"><section><div class="form-title"><span>01 — 交付设置</span><h2>带走需要的数据</h2></div><form id="export-form" novalidate><div class="fields"><label>导出图层<select id="export-layer">${options(exportLayers(), state.layerId)}</select></label>${
    raster
      ? '<p class="hint">栅格保留原始 GeoTIFF，当前不提供重投影和字段选择。</p>'
      : `<div class="field-pair"><label>文件格式<select id="format">${[
          ["geojson", "GeoJSON"],
          ["gpkg", "GeoPackage"],
          ["shp", "Shapefile ZIP"],
          ["csv", "CSV + WKT"],
        ]
          .map(
            ([v, t]) =>
              `<option value="${v}" ${state.format === v ? "selected" : ""}>${t}</option>`,
          )
          .join(
            "",
          )}</select></label><label>坐标系 / EPSG<input id="crs" type="number" min="1" step="1" value="${esc(state.crs)}"></label></div>`
  }<label>文件名称（可选）<input id="filename" placeholder="${esc(l?.name ?? "数据名称")}" value="${esc(state.filename)}"></label></div>${!raster && fields.length ? `<fieldset class="check-list"><legend>保留字段</legend>${fields.map((f) => `<label><input type="checkbox" data-field="${esc(f.name)}" ${state.excluded.has(f.name) ? "" : "checked"}>${esc(f.name)}</label>`).join("")}</fieldset>` : ""}<div class="form-actions"><button class="primary" type="submit">检查交付设置 <span>→</span></button></div><div id="export-feedback" class="feedback" role="status"></div></form><p class="capability">矢量支持 GeoJSON、GeoPackage、Shapefile 与 CSV。这里按选中图层导出，不提供任意框选裁剪。</p></section><section>${mapPanel(l, "待交付图层")}<div class="export-summary"><p class="eyebrow">交付预览</p><div class="big-format">${raster ? "GeoTIFF" : { geojson: "GeoJSON", gpkg: "GeoPackage", shp: "Shapefile", csv: "CSV + WKT" }[state.format]}</div><div class="hint">${esc(l?.name ?? "尚未选择图层")}<br>${raster ? "原始栅格" : `${count(l?.featureCount)} 要素 · EPSG:${esc(state.crs)}`} · 尚未生成文件</div></div></section></div><section style="margin-top:25px">${sectionTitle("已有交付记录", "历史快照")}<div class="table-wrap"><table><thead><tr><th>文件</th><th>格式</th><th>大小</th><th>状态</th></tr></thead><tbody>${
    exports
      .slice(0, 3)
      .map(
        (t) =>
          `<tr><td><button data-task-link="${t.id}">${esc(t.result?.downloadName ?? "未生成文件")} ↗</button></td><td class="mono">${esc(t.result?.format ?? "—")}</td><td class="mono">${t.result?.sizeBytes ? (t.result.sizeBytes / 1048576).toFixed(2) + " MB" : "—"}</td><td>${statusTag(t.state)}</td></tr>`,
      )
      .join("") || '<tr><td colspan="4">暂无导出记录</td></tr>'
  }</tbody></table></div></section>`;
}
function overviewPage() {
  if (!snapshot.capturedAt)
    return '<section role="alert" class="empty">资料暂时无法读取，统计尚未就绪。<br>请重新打开，或返回设计入口查看已保存画面。</section>';
  const failed = snapshot.tasks.filter((t) => t.state === "failed").length;
  return `<p class="page-lead">所有项目的共同入口。把注意力放回正在做的事。</p><div class="stat-line"><div><div class="number">${snapshot.projects.length}</div><div class="label">项目</div></div><div><div class="number">${layers().length}</div><div class="label">已绑定图层</div></div><div><div class="number">${snapshot.tasks.length}</div><div class="label">已读取的历史作业</div></div><div><div class="number">${failed}</div><div class="label">失败记录</div></div></div><div class="split"><section>${sectionTitle("项目索引", "现有项目 · API 返回顺序")}${snapshot.projects.map((p, i) => `<button class="project-row" data-overview-project="${p.id}"><span class="project-num">0${i + 1}</span><span><h3>${esc(p.name)}</h3><span class="hint">${p.layers.length} 层数据</span></span><span class="arrow">↗</span></button>`).join("")}<p class="hint" style="margin-top:20px">项目接口未提供更新时间，因此不推定最近编辑顺序。</p></section><section>${sectionTitle("从这里继续", "全局索引")}<div class="index-links">${FEATURES.filter(
    (f) => f.id !== "overview",
  )
    .map((f) => `<button data-nav="${f.id}">${f.title}<span>↗</span></button>`)
    .join(
      "",
    )}</div><div style="margin-top:35px">${sectionTitle("最近作业", "按任务创建时间")}${snapshot.tasks
    .slice(0, 2)
    .map(
      (t) =>
        `<button class="timeline-row" data-task-link="${t.id}"><span class="date">${t.createdAt.slice(5, 10)}<br>2026</span><span><h3>${esc(taskName(t))}</h3><span class="hint">${esc(t.projectName)}</span></span>${statusTag(t.state)}</button>`,
    )
    .join("")}</div></section></div>`;
}
function feedback(id, text, error = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("error", error);
}
function validateAnalysis() {
  const selected = layer(),
    secondary = vecLayers().find((l) => l.id === state.secondary);
  let error = "";
  if (!project()) error = "先选择工作项目。";
  else if (!selected || !vecLayers().some((l) => l.id === selected.id))
    error = "请选择可分析的矢量图层。";
  else if (
    ["clip", "intersection", "spatial-join", "point-in-polygon"].includes(
      state.tool,
    ) &&
    !secondary
  )
    error = "请选择关联图层。";
  else if (
    state.tool === "buffer" &&
    (!Number.isFinite(Number(state.distance)) || Number(state.distance) <= 0)
  )
    error = "缓冲距离必须是大于 0 的有限数值，单位是米。";
  else if (
    state.tool === "point-in-polygon" &&
    !/POINT/.test(selected.geometryType ?? "")
  )
    error = "点图层需要 POINT 或 MULTIPOINT 类型。";
  else if (
    state.tool === "point-in-polygon" &&
    secondary &&
    !/POLYGON|GEOMETRY/.test(secondary.geometryType ?? "")
  )
    error = "目标图层需要多边形几何。";
  else if (!state.outputName.trim()) error = "请填写输出数据名称。";
  feedback(
    "#analysis-feedback",
    error || "参数检查通过。设计预演已保留设置；尚未提交作业，没有新结果。",
    !!error,
  );
}
function validateExport() {
  const l = layer(),
    fields = snapshot.fields[l?.id]?.fields ?? [];
  let error = "";
  if (!project() || !l || !exportLayers().some((x) => x.id === l.id))
    error = "先选择项目与可导出的图层。";
  else if (
    l.kind !== "raster" &&
    (!Number.isInteger(Number(state.crs)) || Number(state.crs) <= 0)
  )
    error = "EPSG 编号需要是正整数。";
  else if (
    l.kind !== "raster" &&
    fields.length &&
    fields.every((f) => state.excluded.has(f.name))
  )
    error = "至少保留一个字段。";
  feedback(
    "#export-feedback",
    error ||
      "交付设置检查通过。设计预演不生成文件；坐标系可用性将在正式提交时确认。",
    !!error,
  );
}
document.addEventListener("click", (e) => {
  const button = e.target.closest("button,a");
  if (!button) return;
  if (button.dataset.feature) {
    e.preventDefault();
    nav(button.dataset.feature);
  } else if (button.dataset.nav) nav(button.dataset.nav);
  else if (button.dataset.project) {
    setProject(button.dataset.project);
  } else if (button.dataset.data) {
    state.dataKey = button.dataset.data;
    const l = layers().find((l) => l.id === state.dataKey);
    if (l) setLayer(l.id);
    else setLayer("");
    renderPage();
  } else if (button.dataset.tool) {
    state.tool = button.dataset.tool;
    renderPage();
    renderDialogue();
  } else if (button.dataset.task) {
    state.taskId = button.dataset.task;
    writeRoute(true);
    renderPage();
  } else if (button.dataset.taskLink) {
    state.taskId = button.dataset.taskLink;
    nav("tasks");
  } else if (button.dataset.overviewProject) {
    setProject(button.dataset.overviewProject);
    nav("projects");
  } else if (button.hasAttribute("data-open-data") || button.dataset.analyze) {
    const id = button.dataset.openData || button.dataset.analyze;
    const l = layers().find((l) => l.id === id);
    if (l) {
      state.projectId = l.projectId;
      state.layerId = l.id;
      state.dataKey = l.id;
      nav(button.dataset.analyze ? "analysis" : "data");
      scene?.setContext(snapshot, l);
    }
  } else if (button.dataset.map)
    location.href =
      "map-design.html?projectId=" +
      encodeURIComponent(state.projectId) +
      "&layerId=" +
      encodeURIComponent(state.layerId);
  else if (button.dataset.demo) inform(button.dataset.demo);
});
document.addEventListener("change", (e) => {
  const el = e.target,
    id = el.id;
  if (["home-project", "work-project"].includes(id))
    return setProject(el.value);
  if (["analysis-layer", "export-layer", "home-layer"].includes(id)) {
    setLayer(el.value);
    renderAll();
    return;
  }
  const bindings = {
    secondary: "secondary",
    distance: "distance",
    "output-name": "outputName",
    "by-field": "byField",
    predicate: "predicate",
    format: "format",
    crs: "crs",
    filename: "filename",
    "data-kind": "kind",
    "task-state": "taskState",
    "task-type": "taskType",
  };
  if (bindings[id]) state[bindings[id]] = el.value;
  if (el.dataset.field) {
    if (el.checked) state.excluded.delete(el.dataset.field);
    else state.excluded.add(el.dataset.field);
  }
  if (["format", "data-kind", "task-state", "task-type"].includes(id))
    renderPage();
});
document.addEventListener("input", (e) => {
  const id = e.target.id;
  const b = {
    distance: "distance",
    "output-name": "outputName",
    crs: "crs",
    filename: "filename",
  };
  if (b[id]) state[b[id]] = e.target.value;
  if (["project-search", "data-search"].includes(id)) {
    state[id === "project-search" ? "projectSearch" : "dataSearch"] =
      e.target.value;
    const pos = e.target.selectionStart;
    renderPage();
    document.getElementById(id).setSelectionRange(pos, pos);
  }
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "analysis-form") {
    e.preventDefault();
    validateAnalysis();
  }
  if (e.target.id === "export-form") {
    e.preventDefault();
    validateExport();
  }
});
$("#expand").onclick = expand;
$("#cancel-preview").onclick = home;
$("#return-home").onclick = home;
$("#menu-toggle").onclick = () => {
  const open = $("#navigation").classList.toggle("open");
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
};
$("#motion").onclick = () => {
  state.reduced = !state.reduced;
  renderAll();
  scene?.setReduced(state.reduced);
};
matchMedia("(prefers-reduced-motion: reduce)").addEventListener(
  "change",
  (e) => {
    state.reduced = e.matches;
    renderAll();
    scene?.setReduced(e.matches);
    if (e.matches && state.mode === "expanding")
      finishExpand(state.transitionId);
  },
);
addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("#navigation").classList.contains("open")) {
      $("#navigation").classList.remove("open");
      $("#menu-toggle").setAttribute("aria-expanded", "false");
      $("#menu-toggle").focus();
    } else if (state.mode !== "home") home();
  }
});
addEventListener("popstate", restore);
addEventListener("hashchange", () => {
  if (location.hash !== url()) restore();
});
restore();
window.D01 = {
  version: "D01-R1.1",
  state,
  snapshot,
  ready: false,
  metrics: () =>
    scene?.metrics() ?? {
      fallback: true,
      canvasCount: document.querySelectorAll("canvas").length,
    },
  captureAt: (mode, ms = 0, id = "analysis") => {
    clearTimeout(transitionTimer);
    state.feature = mode === "home" ? null : id;
    state.mode = mode;
    state.transitionId++;
    renderAll();
    scene?.captureAt(state, ms);
  },
  resume: () => scene?.resume(),
  select: nav,
  expand,
  home,
  setProject,
  setLayer,
  getScene: () => scene,
};
try {
  if (new URLSearchParams(location.search).has("static"))
    throw Error("Static preview requested");
  const { Observatory } = await import("./scene.mjs");
  scene = new Observatory($("#stage"), $("#projection"), snapshot);
  await scene.load();
  scene.setContext(snapshot, layer());
  scene.setReduced(state.reduced);
  scene.setState(state, true);
  $("#model-state").textContent = "";
  document.body.classList.remove("loading-scene");
  window.D01.ready = true;
} catch (error) {
  sceneFailed = true;
  document.body.classList.remove("loading-scene");
  document.body.classList.add("static-scene");
  renderAll();
  $("#model-state").textContent = "静态陪伴 · 导航与内容仍可使用";
  if (!new URLSearchParams(location.search).has("static"))
    console.warn("Model fallback:", error.message);
  window.D01.ready = true;
}
