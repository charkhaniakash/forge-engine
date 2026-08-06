import { useEffect, useRef, useState } from 'react'
import { useAppSelector } from '@/app/hooks'
import styles from './workspace.module.css'

const PHASE_LABELS: Record<string, string> = {
  planning:   'Planning',
  executing:  'Executing',
  validation: 'Validating',
  repair:     'Repairing',
  publishing: 'Publishing',
}

const PHASE_COLORS: Record<string, string> = {
  planning:   '#A78BFA',
  executing:  'var(--accent)',
  validation: '#60A5FA',
  repair:     '#FB923C',
  publishing: '#34D399',
}

function useElapsedTimer(active: boolean) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (active) {
      startRef.current = Date.now()
      setElapsed(0)
      const id = setInterval(() => {
        setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000))
      }, 1000)
      return () => clearInterval(id)
    } else {
      startRef.current = null
    }
  }, [active])

  return elapsed
}

function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

interface TaskStatusBarProps {
  /** Current live phase: planning, executing, validation, repair, publishing */
  livePhase?: string
  /** Whether ANY phase is actively streaming */
  isLive?: boolean
}

export function TaskStatusBar({ livePhase, isLive = false }: TaskStatusBarProps) {
  const activeFilePath = useAppSelector((s) => s.workspaceEditor?.activeFilePath)
  // Workspace socket connection — this IS correct (set by useWorkspaceSocket)
  const wsStatus      = useAppSelector((s) => s.workspaceEditor?.connectionStatus ?? 'idle')
  // AI activity events from workspace socket — source of current tool/action
  const aiEvents      = useAppSelector((s) => s.workspaceActivity?.aiEvents ?? [])

  const isRunning = isLive
  const elapsed   = useElapsedTimer(isRunning)

  const lastTool  = [...aiEvents].reverse().find((e) => e.tool)?.tool ?? null
  const lastLabel = aiEvents.length > 0 ? aiEvents[aiEvents.length - 1].label : null

  const phaseKey   = livePhase ?? 'idle'
  const phaseLabel = PHASE_LABELS[phaseKey] ?? 'Idle'
  const phaseColor = isLive ? (PHASE_COLORS[phaseKey] ?? 'var(--accent)') : 'var(--text-tertiary)'

  const wsConnected = wsStatus === 'connected'
  const wsConnColor = wsConnected ? '#10B981' : wsStatus === 'connecting' ? '#F59E0B' : '#52525B'
  const wsLabel     = wsConnected ? 'Workspace' : wsStatus === 'connecting' ? 'Connecting…' : ''

  const fileName = activeFilePath ? activeFilePath.split('/').pop() : null

  return (
    <div className={styles.statusBar}>
      {/* ── Left: Phase + current action ─────────────────────────────────── */}
      <div className={styles.statusLeft}>
        <div className={styles.statusGroup}>
          <span
            className={styles.statusPhaseDot}
            style={{
              background: phaseColor,
              animation: isRunning ? 'status-pulse 1.6s ease infinite' : 'none',
            }}
          />
          <span className={styles.statusPhaseLabel} style={{ color: phaseColor }}>
            {phaseLabel}
          </span>
        </div>

        {isRunning && lastLabel && (
          <>
            <span className={styles.statusSep}>/</span>
            <span className={styles.statusAction} title={lastLabel}>
              {lastLabel.length > 50 ? lastLabel.slice(0, 50) + '…' : lastLabel}
            </span>
          </>
        )}

        {isRunning && lastTool && (
          <>
            <span className={styles.statusSep}>·</span>
            <span className={styles.statusTool}>{lastTool}</span>
          </>
        )}
      </div>

      {/* ── Center: Active file ──────────────────────────────────────────── */}
      <div className={styles.statusCenter}>
        {fileName && (
          <span className={styles.statusFile} title={activeFilePath ?? ''}>
            {fileName}
          </span>
        )}
      </div>

      {/* ── Right: Workspace connection + elapsed timer ──────────────────── */}
      <div className={styles.statusRight}>
        {isRunning && (
          <span className={styles.statusTimer}>{fmtElapsed(elapsed)}</span>
        )}
        {wsConnected && (
          <>
            <span className={styles.statusSep}>·</span>
            <div className={styles.statusGroup}>
              <span className={styles.connectionDot} style={{ backgroundColor: wsConnColor }} />
              <span className={styles.statusLabel}>{wsLabel}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
