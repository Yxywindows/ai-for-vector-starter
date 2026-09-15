import type { MouseEvent } from 'react'

import type { FeatureDefinition } from '../featureRegistry'
import type { ExperiencePhase } from '../experienceReducer'

export interface ExperienceStageProps {
  feature: FeatureDefinition | null
  phase: ExperiencePhase
  onExpand: (event: MouseEvent<HTMLAnchorElement>) => void
  onCancel: () => void
}

function ContourLines() {
  return (
    <svg
      className="experience__contours"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden={true}
      focusable={false}
    >
      <g fill="none" stroke="currentColor" strokeWidth="1">
        <path d="M810 934c-10-114 44-197 151-248 99-48 206-29 268-101 65-75 54-192 147-257 31-22 68-36 110-42" />
        <path d="M776 914c-18-135 37-230 156-286 107-50 215-34 287-112 68-74 70-190 163-258 33-24 69-41 108-51" />
        <path d="M742 892c-25-151 29-260 163-323 114-54 224-39 305-122 75-76 86-193 181-264 34-26 71-46 107-59" />
        <path d="M708 869c-32-168 20-288 168-359 122-58 233-44 326-133 81-78 103-196 199-272 34-27 71-50 105-67" />
        <path d="M674 844c-39-184 10-317 173-396 130-63 241-49 346-144 89-81 119-202 217-283 33-28 69-53 101-73" />
        <path d="M640 816c-46-199-1-345 177-433 137-67 251-54 369-155 97-83 138-207 237-294 32-28 66-56 96-78" />
        <path d="M934 968c4-81 51-142 132-182 79-39 178-43 230-101 59-66 48-165 126-219 19-13 41-23 65-31" />
        <path d="M1055 923c8-50 39-88 92-115 54-27 129-36 164-75 37-42 32-105 78-139 20-15 43-25 69-31" />
        <path d="M1442 536c-52 7-96 28-130 62-61 62-56 158-119 205-63 48-161 38-224 91-42 36-65 84-70 143" />
        <path d="M1438 579c-39 9-73 25-100 52-56 56-55 144-111 187-57 43-149 36-209 82-38 29-61 71-70 124" />
        <path d="M1434 622c-28 10-52 23-72 43-50 50-54 127-103 166-51 40-137 33-193 73-34 25-57 61-69 105" />
        <path d="M350 55c92 29 143 88 154 177 10 77-18 151 30 207 49 58 137 57 174 121 27 46 28 106 3 181" />
        <path d="M302 54c107 27 169 93 182 198 10 84-14 156 38 215 53 60 146 64 188 133 30 50 34 113 14 188" />
        <path d="M254 56c121 22 196 96 214 217 13 91-7 164 49 224 57 62 156 71 201 145 33 54 42 121 28 197" />
      </g>
    </svg>
  )
}

function ExpandArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden={true}>
      <path
        d="M3 8h9m-4-4 4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ExperienceStage({ feature, phase, onExpand, onCancel }: ExperienceStageProps) {
  return (
    <main className="experience__stage" aria-label="空间探索入口">
      <div className="experience__scene">
        <ContourLines />

        <div className="experience__scene-layout">
          <section className="experience__intro" aria-labelledby="experience-intro-title">
            <p className="experience__eyebrow">GEOSPATIAL EXPLORER</p>
            <h1 id="experience-intro-title">与小G一起，探索空间。</h1>
            <p className="experience__intro-copy">
              从地图开始，连接数据、分析与决策。选择一个方向，进入属于你的空间工作流。
            </p>
            <p className="experience__intro-footnote">
              <span aria-hidden={true} /> 一张地图，打开更多可能
            </p>
          </section>

          <div className="experience__stage-slot" data-testid="stage-placeholder">
            <div className="experience__stage-glow" aria-hidden={true} />
            <div className="experience__stage-ring" aria-hidden={true} />
            <div className="experience__stage-horizon" aria-hidden={true} />

            {feature ? (
              <article
                className="experience__preview"
                data-testid="feature-preview"
                aria-labelledby="experience-preview-title"
              >
                <p className="experience__preview-kicker">{feature.kicker}</p>
                <h2 id="experience-preview-title">{feature.label}</h2>
                <p className="experience__preview-summary">{feature.summary}</p>
                <div className="experience__preview-actions">
                  <a
                    className="experience__expand"
                    href={feature.href}
                    onClick={onExpand}
                    aria-disabled={phase !== 'preview' || undefined}
                  >
                    展开工作台
                    <ExpandArrow />
                  </a>
                  <button
                    className="experience__back"
                    type="button"
                    onClick={onCancel}
                    aria-label={`返回空间探索，取消${feature.label}预览`}
                  >
                    返回
                  </button>
                </div>
              </article>
            ) : null}

            <p className="experience__stage-note">
              <span className="experience__stage-note-mark" aria-hidden={true} />
              Snow v4 · 三维角色制作中
            </p>
          </div>
        </div>

        <aside className="experience__guide" aria-live="polite" aria-atomic={true}>
          <span className="experience__guide-mark" aria-hidden={true}>
            G
          </span>
          <div className="experience__guide-copy">
            <p className="experience__guide-label">小G · 空间向导</p>
            <p className="experience__guide-text">
              {feature?.dialogue ?? '从菜单选一个方向吧，我陪你一起把空间数据变成清晰的发现。'}
            </p>
          </div>
          <span className="experience__guide-status">
            {feature ? feature.kicker : 'READY TO EXPLORE'}
          </span>
        </aside>
      </div>
    </main>
  )
}
