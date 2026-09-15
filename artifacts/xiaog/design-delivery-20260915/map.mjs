let sketchId = 0;
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function extentText(e) {
  return e?.length === 4 && e.every(Number.isFinite)
    ? e.map((x) => x.toFixed(2)).join(" / ")
    : "暂无空间范围";
}
export function mapSVG(snapshot, layer, width = 640, height = 380) {
  const clipId = "region-" + ++sketchId;
  const sampled = snapshot.geometry?.[layer?.id];
  const e = sampled?.bbox ?? layer?.extent;
  if (
    !e ||
    e.length !== 4 ||
    !e.every(Number.isFinite) ||
    e[2] <= e[0] ||
    e[3] <= e[1]
  )
    return `<svg xmlns="http://www.w3.org/2000/svg" class="map-art" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#dce1db"/><text x="50%" y="50%" text-anchor="middle" fill="#465d68" font-size="18" font-family="sans-serif">暂无空间范围</text></svg>`;
  const padding = 24,
    sx = (width - padding * 2) / (e[2] - e[0]),
    sy = (height - padding * 2) / (e[3] - e[1]),
    scale = Math.min(sx, sy);
  const ox = (width - (e[2] - e[0]) * scale) / 2,
    oy = (height - (e[3] - e[1]) * scale) / 2;
  const xy = (c) => [
    ox + (c[0] - e[0]) * scale,
    height - oy - (c[1] - e[1]) * scale,
  ];
  const ring = (r) =>
    r
      .map(
        (c, i) =>
          `${i ? "L" : "M"}${xy(c)
            .map((x) => x.toFixed(2))
            .join(",")}`,
      )
      .join(" ") + " Z";
  const geopath = (g) =>
    g?.type === "Polygon"
      ? g.coordinates.map(ring).join(" ")
      : g?.type === "MultiPolygon"
        ? g.coordinates.flatMap((p) => p.map(ring)).join(" ")
        : "";
  const color = layer?.style?.fill?.color ?? "#3b82f6",
    stroke = layer?.style?.stroke?.color ?? "#1e3a8a",
    opacity = layer?.style?.fill?.opacity ?? 0.6;
  const paths = (sampled?.data.features ?? [])
    .map(
      (f) =>
        `<path d="${geopath(f.geometry)}" fill="${esc(color)}" fill-opacity="${opacity}" stroke="${esc(stroke)}" stroke-width=".6" fill-rule="evenodd"/>`,
    )
    .join("");
  const grid = Array.from({ length: 5 }, (_, i) => {
    const x = ox + ((width - 2 * ox) * i) / 4,
      y = oy + ((height - 2 * oy) * i) / 4;
    return `<path d="M${x} ${oy}V${height - oy}M${ox} ${y}H${width - ox}" stroke="#617984" stroke-opacity=".15" stroke-width=".7"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" class="map-art" width="${width}" height="${height}" role="img" aria-label="${esc(sampled ? "城市边界局部，简化几何，非测量地图" : "图层范围示意，未载入要素几何")}" viewBox="0 0 ${width} ${height}"><defs><clipPath id="${clipId}"><rect x="${ox}" y="${oy}" width="${width - ox * 2}" height="${height - oy * 2}"/></clipPath></defs><rect width="100%" height="100%" fill="#dce1db"/>${grid}<g clip-path="url(#${clipId})">${paths}</g><rect x="${ox}" y="${oy}" width="${width - ox * 2}" height="${height - oy * 2}" fill="none" stroke="#526d7b" stroke-width="1" stroke-dasharray="${sampled ? "0" : "5 4"}"/>${!sampled ? `<text x="50%" y="49%" text-anchor="middle" fill="#455e6b" font-size="16" font-family="sans-serif">图层范围 · 无要素快照</text>` : ""}<text x="${ox + 8}" y="${oy + 17}" font-size="10" fill="#233e4d" font-family="monospace">N ↑</text><text x="${width - ox}" y="${height - 5}" text-anchor="end" font-size="10" fill="#486571" font-family="monospace">${e[0].toFixed(2)}–${e[2].toFixed(2)}° E · ${e[1].toFixed(2)}–${e[3].toFixed(2)}° N</text></svg>`;
}
