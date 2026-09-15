import type { FeatureId } from '../featureRegistry'

interface FeatureIconProps {
  id: FeatureId
}

/** Small inline marks for the experience rail. They are decorative; nav labels name each action. */
export function FeatureIcon({ id }: FeatureIconProps) {
  const shared = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.5,
  }

  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden={true}
      focusable={false}
      {...shared}
    >
      {id === 'projects' ? (
        <>
          <path d="m3.5 7 5-3 5 3-5 3-5-3Z" />
          <path d="m10.5 11 5-3 5 3-5 3-5-3Z" />
          <path d="m3.5 15 5-3 5 3-5 3-5-3Z" />
          <path d="m8.5 10v2m7-1v2m-7 1v2" opacity=".6" />
        </>
      ) : null}
      {id === 'data' ? (
        <>
          <path d="M4.5 6.5c0-1.1 3.4-2 7.5-2s7.5.9 7.5 2-3.4 2-7.5 2-7.5-.9-7.5-2Z" />
          <path d="M4.5 6.5v5c0 1.1 3.4 2 7.5 2 .8 0 1.6 0 2.3-.1" />
          <path d="M19.5 6.5v3" />
          <path d="M4.5 11.5v5c0 1.1 3.4 2 7.5 2 .8 0 1.5 0 2.2-.1" />
          <path d="M19.5 13.5v5m-2.5-2.5h5" />
        </>
      ) : null}
      {id === 'analysis' ? (
        <>
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m14.5 14.5 5 5M10.5 7.5v6m-3-3h6" />
          <path d="M4.4 4.4 6 6m9-1.6L13.5 6" opacity=".6" />
        </>
      ) : null}
      {id === 'tasks' ? (
        <>
          <rect x="5" y="4.5" width="14" height="16" rx="2" />
          <path d="m8 9 1.4 1.4L12 7.8m1 1.2h3m-8 5 1.4 1.4L12 12.8m1 1.2h3" />
        </>
      ) : null}
      {id === 'exports' ? (
        <>
          <path d="M12 3.5v11m-4-4 4 4 4-4" />
          <path d="M5 14v4.5c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V14" />
          <path d="M7 5.5h3m4 0h3" opacity=".6" />
        </>
      ) : null}
      {id === 'overview' ? (
        <>
          <path d="M12 3.5 20 12l-8 8.5L4 12l8-8.5Z" />
          <path d="M12 7v10m-4.5-5h9" opacity=".75" />
          <circle cx="12" cy="12" r="1.5" />
        </>
      ) : null}
    </svg>
  )
}
