import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { getAttributes, getFields } from '../../api/features'
import { getRasterStatistics } from '../../api/system'
import type { Layer, RasterStyle, StyleSpec, VectorStyle } from '../../api/types'
import { useLayerMutations } from '../layers/useLayerMutations'
import { defaultRasterStyle, defaultVectorStyle, distinctValues, numericRange } from './defaults'
import { buildCategorizedClasses, buildGraduatedClasses, RAMPS, type RampName } from './ramps'

const SAMPLE_SIZE = 500
const GRADUATED_CLASSES = 5

interface StyleEditorProps {
  projectId: string
  layer: Layer
}

export function StyleEditor({ projectId, layer }: StyleEditorProps) {
  const mutations = useLayerMutations(projectId)
  const isRaster = layer.kind === 'raster'

  const [draft, setDraft] = useState<StyleSpec>(
    layer.style ?? (isRaster ? defaultRasterStyle() : defaultVectorStyle()),
  )
  const [ramp, setRamp] = useState<RampName>('viridis')
  const [classifyField, setClassifyField] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const fields = useQuery({
    queryKey: ['fields', layer.id],
    queryFn: () => getFields(layer.id),
    enabled: !isRaster,
  })
  const sample = useQuery({
    queryKey: ['style-sample', layer.id],
    queryFn: () => getAttributes(layer.id, { page: 1, pageSize: SAMPLE_SIZE }),
    enabled: !isRaster,
  })
  const statistics = useQuery({
    queryKey: ['raster-statistics', layer.id],
    queryFn: () => getRasterStatistics(layer.id),
    enabled: isRaster,
  })

  const apply = () => mutations.setStyle.mutate({ layerId: layer.id, style: draft })

  if (isRaster) {
    const raster = draft as RasterStyle
    const band = statistics.data?.bands[0]
    const [min, max] = raster.rescale?.[0] ?? [0, 255]

    return (
      <section className="style-editor">
        <h3>Style · {layer.name}</h3>

        <label>
          Colour map
          <select
            value={raster.colormap ?? ''}
            onChange={(event) => setDraft({ ...raster, colormap: event.target.value || null })}
          >
            <option value="">Greyscale</option>
            {['viridis', 'magma', 'terrain', 'rdylbu'].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Minimum
          <input
            type="number"
            value={min}
            onChange={(event) =>
              setDraft({ ...raster, rescale: [[Number(event.target.value), max]] })
            }
          />
        </label>
        <label>
          Maximum
          <input
            type="number"
            value={max}
            onChange={(event) =>
              setDraft({ ...raster, rescale: [[min, Number(event.target.value)]] })
            }
          />
        </label>

        <button
          type="button"
          disabled={!band}
          onClick={() =>
            band && setDraft({ ...raster, rescale: [[band.percentile2, band.percentile98]] })
          }
        >
          From statistics
        </button>

        <button type="button" className="btn--primary" onClick={apply}>
          Apply
        </button>
      </section>
    )
  }

  const vector = draft as VectorStyle
  const rows = sample.data?.rows ?? []

  const classify = () => {
    setProblem(null)
    if (!classifyField) {
      setProblem('Choose a field first.')
      return
    }
    if (vector.renderer.type === 'categorized') {
      const values = distinctValues(rows, classifyField)
      if (values.length === 0) {
        setProblem('That field has no values in the sample.')
        return
      }
      setDraft({
        ...vector,
        renderer: {
          type: 'categorized',
          field: classifyField,
          categories: buildCategorizedClasses(values, ramp),
          fallbackColor: '#9ca3af',
        },
      })
      return
    }
    const range = numericRange(rows, classifyField)
    if (!range) {
      setProblem('That field has no numeric values in the sample.')
      return
    }
    setDraft({
      ...vector,
      renderer: {
        type: 'graduated',
        field: classifyField,
        method: 'equal_interval',
        classes: buildGraduatedClasses(range[0], range[1], GRADUATED_CLASSES, ramp),
      },
    })
  }

  const classes =
    vector.renderer.type === 'categorized'
      ? vector.renderer.categories
      : vector.renderer.type === 'graduated'
        ? vector.renderer.classes
        : []

  return (
    <section className="style-editor">
      <h3>Style · {layer.name}</h3>

      <label>
        Renderer
        <select
          value={vector.renderer.type}
          onChange={(event) => {
            const type = event.target.value as 'single' | 'categorized' | 'graduated'
            setProblem(null)
            setDraft({
              ...vector,
              renderer:
                type === 'single'
                  ? { type: 'single' }
                  : type === 'categorized'
                    ? {
                        type: 'categorized',
                        field: classifyField,
                        categories: [],
                        fallbackColor: '#9ca3af',
                      }
                    : {
                        type: 'graduated',
                        field: classifyField,
                        method: 'equal_interval',
                        classes: [],
                      },
            })
          }}
        >
          <option value="single">Single symbol</option>
          <option value="categorized">Categorized</option>
          <option value="graduated">Graduated</option>
        </select>
      </label>

      {vector.renderer.type !== 'single' ? (
        <>
          <label>
            Classify by
            <select
              value={classifyField}
              onChange={(event) => setClassifyField(event.target.value)}
            >
              <option value="">Choose a field…</option>
              {fields.data?.fields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Colour ramp
            <select value={ramp} onChange={(event) => setRamp(event.target.value as RampName)}>
              {Object.keys(RAMPS).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <button type="button" onClick={classify}>
            Classify
          </button>

          <ul className="style-editor__classes">
            {classes.map((stop, index) => (
              <li key={index} data-testid="class-row">
                <input
                  type="color"
                  value={stop.color}
                  aria-label={`Colour for class ${index + 1}`}
                  onChange={(event) => {
                    const next = [...classes]
                    next[index] = { ...stop, color: event.target.value }
                    setDraft({
                      ...vector,
                      renderer:
                        vector.renderer.type === 'categorized'
                          ? { ...vector.renderer, categories: next }
                          : vector.renderer.type === 'graduated'
                            ? { ...vector.renderer, classes: next }
                            : vector.renderer,
                    })
                  }}
                />
                <span>{stop.label ?? String(stop.value ?? '')}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <label>
        Fill colour
        <input
          type="color"
          value={vector.fill.color}
          onChange={(event) =>
            setDraft({ ...vector, fill: { ...vector.fill, color: event.target.value } })
          }
        />
      </label>

      <label>
        Fill opacity
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={vector.fill.opacity}
          onChange={(event) =>
            setDraft({ ...vector, fill: { ...vector.fill, opacity: Number(event.target.value) } })
          }
        />
      </label>

      <label>
        Outline colour
        <input
          type="color"
          value={vector.stroke.color}
          onChange={(event) =>
            setDraft({ ...vector, stroke: { ...vector.stroke, color: event.target.value } })
          }
        />
      </label>

      <label>
        Outline width
        <input
          type="number"
          min={0}
          max={20}
          step={0.5}
          value={vector.stroke.width}
          onChange={(event) =>
            setDraft({ ...vector, stroke: { ...vector.stroke, width: Number(event.target.value) } })
          }
        />
      </label>

      <label>
        Marker shape
        <select
          value={vector.marker.shape}
          onChange={(event) =>
            setDraft({
              ...vector,
              marker: {
                ...vector.marker,
                shape: event.target.value as VectorStyle['marker']['shape'],
              },
            })
          }
        >
          <option value="circle">Circle</option>
          <option value="square">Square</option>
          <option value="triangle">Triangle</option>
        </select>
      </label>

      <label>
        Label field
        <select
          value={vector.label?.field ?? ''}
          onChange={(event) =>
            setDraft({
              ...vector,
              label: event.target.value
                ? {
                    field: event.target.value,
                    color: '#111827',
                    size: 12,
                    haloColor: '#ffffff',
                  }
                : null,
            })
          }
        >
          <option value="">No labels</option>
          {fields.data?.fields.map((field) => (
            <option key={field.name} value={field.name}>
              {field.name}
            </option>
          ))}
        </select>
      </label>

      {problem ? <p role="alert">{problem}</p> : null}

      <button type="button" className="btn--primary" onClick={apply}>
        Apply
      </button>
    </section>
  )
}
