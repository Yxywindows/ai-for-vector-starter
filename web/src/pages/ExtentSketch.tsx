/**
 * The thumbnail fallback (IA plan §6): a dataset's extent drawn over a
 * world graticule as plain SVG. Deliberately not a map — no tiles, no
 * engine, no allocation beyond a few DOM nodes.
 */
export function ExtentSketch({ extent }: { extent: number[] | null }) {
  const x = (lon: number) => ((lon + 180) / 360) * 128
  const y = (lat: number) => ((90 - lat) / 180) * 64

  return (
    <svg
      className="extent-sketch"
      viewBox="0 0 128 64"
      role="img"
      aria-label={extent ? 'Spatial extent sketch' : 'No spatial extent'}
    >
      {[-120, -60, 0, 60, 120].map((lon) => (
        <line key={`m${lon}`} x1={x(lon)} y1={0} x2={x(lon)} y2={64} className="extent-sketch__grid" />
      ))}
      {[-60, -30, 0, 30, 60].map((lat) => (
        <line key={`p${lat}`} x1={0} y1={y(lat)} x2={128} y2={y(lat)} className="extent-sketch__grid" />
      ))}
      {extent && extent.length === 4 ? (
        <rect
          x={x(extent[0]!)}
          y={y(extent[3]!)}
          width={Math.max(2, x(extent[2]!) - x(extent[0]!))}
          height={Math.max(2, y(extent[1]!) - y(extent[3]!))}
          className="extent-sketch__extent"
        />
      ) : null}
    </svg>
  )
}
