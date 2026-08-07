import { useEffect, useRef, useState } from 'react'
import { useAppSelector } from '@/app/hooks'
import { cn } from '@/lib/utils'

const PHASE: Record<string, { text: string; dot: string; label: string }> = {
  planning:   { text: 'text-purple-400', dot: 'bg-purple-400', label: 'Planning' },
  executing:  { text: 'text-primary',    dot: 'bg-primary',    label: 'Executing' },
  validation: { text: 'text-info',       dot: 'bg-info',       label: 'Validating' },
  repair:     { text: 'text-warning',    dot: 'bg-warning',    label: 'Repairing' },
  publishing: { text: 'text-success',    dot: 'bg-success',    label: 'Publishing' },
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
  // Workspace socket connection — set by useWorkspaceSocket (correct source).
  const wsStatus = useAppSelector((s) => s.workspaceEditor?.connectionStatus ?? 'idle')
  const aiEvents = useAppSelector((s) => s.workspaceActivity?.aiEvents ?? [])

  const isRunning = isLive
  const elapsed = useElapsedTimer(isRunning)

  const lastTool = [...aiEvents].reverse().find((e) => e.tool)?.tool ?? null
  const lastLabel = aiEvents.length > 0 ? aiEvents[aiEvents.length - 1].label : null

  const phase = (livePhase && PHASE[livePhase]) || null
  const phaseLabel = phase?.label ?? 'Idle'
  const phaseText = isLive && phase ? phase.text : 'text-fg-subtle'
  const phaseDot = isLive && phase ? phase.dot : 'bg-fg-subtle'

  const wsConnected = wsStatus === 'connected'
  const wsConnColor = wsConnected ? 'bg-success' : wsStatus === 'connecting' ? 'bg-warning' : 'bg-fg-subtle'
  const wsLabel = wsConnected ? 'Workspace' : wsStatus === 'connecting' ? 'Connecting…' : ''

  const fileName = activeFilePath ? activeFilePath.split('/').pop() : null

  return (
    <div className="flex h-7 flex-shrink-0 items-center gap-2 border-t border-line bg-surface px-3 font-mono text-[11px]">
      {/* Left: phase + current action */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 rounded-full', phaseDot, isRunning && 'animate-pulse')} />
          <span className={cn('font-medium', phaseText)}>{phaseLabel}</span>
        </span>

        {isRunning && lastLabel && (
          <>
            <span className="text-fg-subtle opacity-50">/</span>
            <span className="truncate text-fg-muted" title={lastLabel}>
              {lastLabel.length > 50 ? lastLabel.slice(0, 50) + '…' : lastLabel}
            </span>
          </>
        )}
        {isRunning && lastTool && (
          <>
            <span className="text-fg-subtle opacity-50">·</span>
            <span className="text-fg-subtle">{lastTool}</span>
          </>
        )}
      </div>

      {/* Center: active file */}
      <div className="mx-auto min-w-0">
        {fileName && (
          <span className="truncate text-fg-subtle" title={activeFilePath ?? ''}>
            {fileName}
          </span>
        )}
      </div>

      {/* Right: elapsed timer + workspace connection */}
      <div className="flex flex-shrink-0 items-center gap-2">
        {isRunning && <span className="text-fg-muted tabular-nums">{fmtElapsed(elapsed)}</span>}
        {wsConnected && (
          <>
            <span className="text-fg-subtle opacity-50">·</span>
            <span className="flex items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', wsConnColor)} />
              <span className="text-fg-subtle">{wsLabel}</span>
            </span>
          </>
        )}
      </div>
    </div>
  )
}
