import type { SVGProps } from 'react'

/**
 * Minimal inline icon set (stroke-based, currentColor). Keeps the bundle free
 * of an icon dependency while giving the UI a consistent 1.5px-stroke look.
 */

export type IconName =
  | 'dashboard'
  | 'repo'
  | 'chat'
  | 'task'
  | 'execution'
  | 'org'
  | 'settings'
  | 'build'
  | 'repair'
  | 'git'
  | 'workspace'
  | 'audit'
  | 'usage'
  | 'search'
  | 'bell'
  | 'sun'
  | 'moon'
  | 'chevronRight'
  | 'chevronDown'
  | 'chevronLeft'
  | 'check'
  | 'x'
  | 'plus'
  | 'play'
  | 'refresh'
  | 'file'
  | 'branch'
  | 'clock'
  | 'alert'
  | 'logout'
  | 'externalLink'
  | 'sidebar'
  | 'dot'
  | 'spinner'
  | 'code'
  | 'tool'
  | 'pause'
  | 'stop'
  | 'sparkles'
  | 'folder'
  | 'monitor'
  | 'alertCircle'
  | 'inbox'
  | 'box'

const PATHS: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 14h7v7H3z',
  repo: 'M4 4v16h14M8 4v13M4 8h4M18 4v16l-3-2-3 2V4z',
  chat: 'M4 5h16v11H9l-4 4v-4H4z',
  task: 'M9 6h11M9 12h11M9 18h11M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17',
  execution: 'M5 4v16M5 8h9l3 3-3 3H5',
  org: 'M4 20v-2a4 4 0 0 1 4-4h2M14 14h2a4 4 0 0 1 4 4v2M9 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-4l-.4 2.6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6c.06-.33.1-.66.1-1z',
  build: 'M14 7l3 3M5 19l8-8M17 3l4 4-9 9-4 1 1-4z',
  repair:
    'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z',
  git: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM15 8c0 4-9 1-9 7',
  workspace: 'M3 4h18v12H3zM8 20h8M12 16v4',
  audit: 'M9 3h6l1 4H8zM6 7h12v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1zM9 12h6M9 16h4',
  usage: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  bell: 'M18 9a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10.3 21a2 2 0 0 0 3.4 0',
  sun: 'M12 4V2M12 22v-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M4 12H2M22 12h-2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronLeft: 'M15 6l-6 6 6 6',
  check: 'M5 13l4 4L19 7',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  play: 'M6 4l14 8-14 8z',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  file: 'M6 2h9l5 5v15H6zM14 2v6h6',
  branch: 'M6 3v18M6 9c0-3 12 0 12-6M18 3v0M18 3a1 1 0 1 0 0 .01M6 3a1 1 0 1 0 0 .01M6 21a1 1 0 1 0 0 .01',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 3',
  alert: 'M12 3 2 20h20zM12 9v5M12 17v.01',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 12h10M13 8l-3 4 3 4',
  externalLink: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  dot: 'M12 12a1 1 0 1 0 .01 0',
  spinner: 'M12 3a9 9 0 1 0 9 9',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z',
  pause: 'M9 4v16M15 4v16',
  stop: 'M6 6h12v12H6z',
  sparkles:
    'M12 3l1.7 4.5L18 9l-4.3 1.5L12 15l-1.7-4.5L6 9l4.3-1.5zM18 14l.9 2.3 2.1.7-2.1.7-.9 2.3-.9-2.3-2.1-.7 2.1-.7z',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  monitor: 'M3 4h18v13H3zM8 21h8M12 17v4',
  alertCircle: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v5M12 16v.01',
  inbox: 'M4 4h16v10H4zM4 14h4l2 3h4l2-3h4',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
