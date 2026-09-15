import { mapSVG, esc } from "./map.mjs";
const $ = (s) => document.querySelector(s);
const snapshot = await fetch("./data/snapshot.json").then((r) => r.json());
const params = new URLSearchParams(location.search);
const p = snapshot.projects.find((p) => p.id === params.get("projectId"));
const l = p?.layers.find((l) => l.id === params.get("layerId"));
const features = snapshot.geometry[l?.id]?.data.features ?? [];
let selected = features[0]?.id ?? "",
  editing = false;
const drafts = new Map(),
  savedDrafts = new Map();
try {
  const saved = JSON.parse(sessionStorage.getItem("D01-map-design-draft"));
  if (saved?.layerId === l?.id)
    for (const [id, value] of saved.drafts) savedDrafts.set(id, value);
} catch {}
$("#project-name").textContent = (p?.name ?? "尚未选择项目") + " / 地图工作区";
$("#layer-list").innerHTML =
  (p?.layers ?? [])
    .map(
      (layer) =>
        `<label class="layer-item"><input type="checkbox" data-layer="${layer.id}" ${layer.id === l?.id ? "checked" : ""}><span>${esc(layer.name)}<br><small class="mono">${esc(layer.geometryType)} · ${layer.featureCount} 要素</small></span></label>`,
    )
    .join("") || '<p class="hint">请选择项目后查看图层。</p>';
function renderMap(empty = false) {
  $("#map-svg").innerHTML = mapSVG(snapshot, empty ? null : l, 1150, 520);
  $("#map-svg svg").style.height = "100%";
  $("#map-svg svg").style.width = "100%";
}
function renderTable() {
  const rows = features.slice(0, 8);
  $("#attribute-count").textContent =
    `局部 ${features.length} 项 · 显示前 ${rows.length} 项`;
  $("#attribute-table").innerHTML =
    `<table><thead><tr><th>FID</th><th>名称</th><th>行政编码</th><th>层级</th><th>来源图层</th></tr></thead><tbody>${rows.map((f) => `<tr class="${selected === f.id ? "selected" : ""}"><td><button data-select="${f.id}">${esc(f.id)}</button></td><td>${editing && selected === f.id ? `<input id="draft-name" aria-label="编辑名称" value="${esc(drafts.get(f.id) ?? savedDrafts.get(f.id) ?? f.properties.name)}">` : esc(drafts.get(f.id) ?? savedDrafts.get(f.id) ?? f.properties.name)}</td><td class="mono">${esc(f.properties.adcode)}</td><td>${esc(f.properties.level)}</td><td>城市边界</td></tr>`).join("") || '<tr><td colspan="5">当前图层未保存要素属性快照。</td></tr>'}</tbody></table>`;
  updateDirty();
}
function updateDirty() {
  $("#draft-state").textContent = drafts.size
    ? `${drafts.size} 条未保存更改`
    : "没有未保存更改";
  $("#save").disabled = !drafts.size;
}
function inform(text) {
  $("#map-feedback").textContent = text;
  setTimeout(() => ($("#map-feedback").textContent = ""), 5500);
}
function target() {
  const q = new URLSearchParams();
  if (p) q.set("projectId", p.id);
  if (l) q.set("layerId", l.id);
  return "prototype.html#/analysis?" + q;
}
function leave() {
  if (drafts.size) {
    $("#save-error").textContent = "";
    $("#leave-dialog").showModal();
    $("#keep-editing").focus();
  } else location.href = target();
}
function save() {
  if ($("#fail-save").checked) {
    $("#save-error").textContent = "保存未成功。草稿仍保留，请重试或继续编辑。";
    inform("保存失败的设计状态：仍保留草稿与页面。");
    return false;
  }
  const merged = new Map([...savedDrafts, ...drafts]);
  try {
    sessionStorage.setItem(
      "D01-map-design-draft",
      JSON.stringify({
        projectId: p?.id,
        layerId: l?.id,
        drafts: [...merged],
        savedAt: new Date().toISOString(),
        scope: "design-page local-only",
      }),
    );
  } catch {
    $("#save-error").textContent = "当前标签页无法保存草稿。更改仍保留，请继续编辑或重试。";
    inform("草稿未能保存，更改仍留在当前页面。");
    return false;
  }
  for (const [id, value] of merged) savedDrafts.set(id, value);
  drafts.clear();
  updateDirty();
  inform("设计草稿已保留在当前标签页；没有写入空间数据库。");
  return true;
}
document.addEventListener("click", (e) => {
  const id = e.target.closest("[data-select]")?.dataset.select;
  if (id) {
    selected = id;
    renderTable();
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "draft-name") {
    const original =
      savedDrafts.get(selected) ??
      features.find((f) => f.id === selected)?.properties.name;
    if (e.target.value === original) drafts.delete(selected);
    else drafts.set(selected, e.target.value);
    updateDirty();
  }
});
$("#edit").onclick = () => {
  editing = !editing;
  $("#edit").setAttribute("aria-pressed", String(editing));
  renderTable();
  $("#draft-name")?.focus();
};
$("#fit").onclick = () => {
  renderMap($("#empty-map").checked);
  inform(l ? "已查看同一图层的局部观察范围。" : "当前没有可定位的空间范围。");
};
$("#select-tool").onclick = () => inform("选择下方记录，查看对应属性。");
$("#empty-map").onchange = (e) => renderMap(e.target.checked);
document.addEventListener("change", (e) => {
  if (e.target.dataset.layer) {
    if (e.target.dataset.layer === l?.id) renderMap(!e.target.checked);
    else inform("此图层未保存要素快照；可返回项目页查看其范围。");
  }
});
$("#leave").onclick = $("#mobile-leave").onclick = leave;
$("#save").onclick = save;
$("#keep-editing").onclick = () => $("#leave-dialog").close();
$("#discard-leave").onclick = () => {
  drafts.clear();
  location.href = target();
};
$("#save-leave").onclick = () => {
  if (save()) location.href = target();
};
addEventListener("beforeunload", (e) => {
  if (drafts.size) {
    e.preventDefault();
    e.returnValue = "";
  }
});
renderMap();
renderTable();
window.mapDesign = { ready: true, drafts, leave, save };
