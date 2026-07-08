import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  LogViewer,
  PageHeader,
  Spinner,
  StatusBadge,
  type LogLine,
} from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { useSocketChannel } from '@/hooks/useSocketChannel'
import { useAuth } from '@/hooks/useAuth'
import { useGetTaskQuery } from '@/services/api/taskApi'
import { useGetExecutionQuery } from '@/services/api/executionApi'
import {
  useGetValidationQuery,
  useGetValidationDiagnosticsQuery,
} from '@/services/api/validationApi'
import { useGetRepairSessionByTaskQuery } from '@/services/api/repairApi'
import {
  VALIDATION_RUN_STATUS,
  VALIDATION_STAGE_STATUS,
  VALIDATION_OVERALL_RESULT,
  resolveStatus,
} from '@/constants/status'
import { ROUTES, routeTo } from '@/constants/routes'
import { appendRepairEvent } from '@/store/slices/streamSlice'
import { websocketBase } from '@/constants/config'
import type { ValidationDiagnostic, ValidationStage } from '@/types'
import type { RepairSocketEvent } from '@/types/repair'
import styles from './Validation.module.css'

const STAGE_ICON: Record<string, string> = {
  install: '📦',
  build: '🔨',
  test: '🧪',
  lint: '🔍',
  format: '✨',
}

function stageDuration(stage: ValidationStage): string | undefined {
  if (!stage.duration_ms) return undefined
  if (stage.duration_ms < 1000) return `${stage.duration_ms}ms`
  return `${(stage.duration_ms / 1000).toFixed(1)}s`
}

export function Validation() {
  const { id: taskId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { token } = useAuth()

  const [selectedStage, setSelectedStage] = useState<string | null>(null)
  // Derived repair UI state from socket events
  const [repairStatus, setRepairStatus] = useState<'idle' | 'running' | 'passed' | 'escalated'>('idle')

  const withRepo = (p: string) => `${p}?repo=${repoId}`

  const { data: taskData } = useGetTaskQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const task = taskData?.task

  const { data: execSnap } = useGetExecutionQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )

  const {
    data: valSnap,
    isLoading: valLoading,
    refetch: refetchVal,
  } = useGetValidationQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId, pollingInterval: 3000 },
  )
  const run = valSnap?.run
  const stages = useMemo(() => valSnap?.stages ?? [], [valSnap])
  const isLive = run?.status === 'pending' || run?.status === 'running'

  const { data: diagnostics = [], refetch: refetchDiags } =
    useGetValidationDiagnosticsQuery(
      { repoId, taskId },
      { skip: !run },
    )

  useSocketChannel({
    channel: 'validation',
    resourceId: taskId,
    path: `/repos/${repoId}/tasks/${taskId}/validation/stream`,
    enabled: Boolean(repoId && taskId) && isLive,
  })
  const live = useAppSelector((s) => s.stream.validation[taskId])

  const lastKind = live?.events[live.events.length - 1]?.kind
  useEffect(() => {
    if (!lastKind) return
    if (['validation_complete', 'stage_diagnostics', 'error'].includes(lastKind)) {
      refetchVal()
      refetchDiags()
    }
  }, [lastKind, live?.events.length, refetchVal, refetchDiags])

  // ── Repair session polling ────────────────────────────────────────────────
  const isRepairable = run?.overall_result === 'failed_repairable'
  const taskExecutionId = run?.task_execution_id ?? ''

  const { data: repairSession } = useGetRepairSessionByTaskQuery(
    taskExecutionId,
    {
      skip: !isRepairable || !taskExecutionId,
      pollingInterval: repairStatus === 'idle' ? 2000 : 0,
    },
  )

  // ── Repair WebSocket ──────────────────────────────────────────────────────
  const repairWsRef = useRef<WebSocket | null>(null)
  const repairSessionId = repairSession?.id

  // Read repair events from the stream slice for the current session
  const repairEvents = useAppSelector((s) =>
    repairSessionId ? (s.stream.repair[repairSessionId]?.events ?? []) : [],
  )

  useEffect(() => {
    if (!repairSessionId || !token) return
    // Already connected or repair finished
    if (repairWsRef.current) return
    if (repairStatus === 'passed' || repairStatus === 'escalated') return

    const sep = `/v1/repair/sessions/${repairSessionId}/stream`.includes('?') ? '&' : '?'
    const url = `${websocketBase()}/repair/sessions/${repairSessionId}/stream${sep}token=${encodeURIComponent(token)}`

    const ws = new WebSocket(url)
    repairWsRef.current = ws

    ws.onmessage = (msg) => {
      let ev: RepairSocketEvent
      try {
        ev = JSON.parse(msg.data as string) as RepairSocketEvent
      } catch {
        return
      }
      dispatch(appendRepairEvent({ sessionId: repairSessionId, event: ev }))
      if (ev.event === 'repair_started' || ev.event === 'attempt_started') {
        setRepairStatus('running')
      } else if (ev.event === 'repair_complete') {
        setRepairStatus('passed')
        refetchVal()
        ws.close()
      } else if (ev.event === 'repair_escalated') {
        setRepairStatus('escalated')
        ws.close()
      }
    }

    ws.onerror = () => {
      ws.close()
    }

    ws.onclose = () => {
      if (repairWsRef.current === ws) repairWsRef.current = null
    }

    return () => {
      ws.close()
      if (repairWsRef.current === ws) repairWsRef.current = null
    }
  // Re-run when session id or token changes; NOT when repairStatus changes
  // to avoid reconnecting after a terminal event.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairSessionId, token, dispatch, refetchVal])

  // ── Derive repair log lines from events ──────────────────────────────────
  function labelRepairEvent(ev: RepairSocketEvent): { text: string; tone: LogLine['tone'] } {
    switch (ev.event) {
      case 'repair_started':
        return { text: `🔧 Repair session started (up to ${ev.max_attempts ?? '?'} attempts)`, tone: 'default' }
      case 'attempt_started':
        return { text: `🔄 Repair attempt ${ev.attempt_number ?? ev.attempt ?? '?'}`, tone: 'default' }
      case 'tool_call':
        return { text: `   Gathering context: ${ev.tool ?? ''}`, tone: 'default' }
      case 'attempt_complete':
        return { text: `   Attempt complete: ${ev.outcome ?? ''}`, tone: 'default' }
      case 'repair_complete':
        return { text: '✓ Repair completed — validation passed', tone: 'success' }
      case 'repair_escalated':
        return { text: `✗ Cannot repair: ${ev.reason ?? 'unknown reason'}`, tone: 'error' }
      default:
        return { text: ev.event, tone: 'default' }
    }
  }

  const visibleDiags: ValidationDiagnostic[] = useMemo(
    () =>
      selectedStage
        ? diagnostics.filter((d) => d.stage === selectedStage)
        : diagnostics,
    [diagnostics, selectedStage],
  )

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warnCount = diagnostics.filter((d) => d.severity === 'warning').length
  const autoFixable = diagnostics.filter((d) => d.repair_category === 'auto_fixable').length

  // Validation log lines + repair log lines appended after
  const repairLogLines: LogLine[] = repairEvents.map((ev, i) => {
    const { text, tone } = labelRepairEvent(ev)
    return { id: 10000 + i, text, tone }
  })

  const logLines: LogLine[] = [
    ...(live?.events ?? []).map((e) => ({
      id: e.seq,
      text: e.label,
      tone:
        e.kind === 'error'
          ? 'error'
          : e.kind === 'validation_complete' && run?.overall_result === 'passed'
            ? 'success'
            : e.kind === 'stage_complete' && (e.raw as { passed?: boolean }).passed === false
              ? 'error'
              : e.kind === 'stage_complete'
                ? 'success'
                : 'default',
    } as LogLine)),
    ...repairLogLines,
  ]

  // Derive the effective status for the header badge
  const effectiveStatus: string | undefined = (() => {
    if (repairStatus === 'running') return '__repairing__'
    if (repairStatus === 'passed') return 'passed'
    if (repairStatus === 'escalated') return '__cannot_repair__'
    return run?.overall_result ?? run?.status
  })()

  const EFFECTIVE_STATUS_MAP: Record<string, { tone: import('@/constants/status').Tone; label: string }> = {
    ...VALIDATION_OVERALL_RESULT,
    ...VALIDATION_RUN_STATUS,
    __repairing__: { tone: 'warning', label: 'Repairing…' },
    __cannot_repair__: { tone: 'danger', label: 'Cannot Repair' },
  }

  // The live activity spinner should also show while repair is running
  const isActivityLive = run?.status === 'running' || repairStatus === 'running'

  if (!repoId) {
    return (
      <EmptyState
        icon={<Icon name="alert" size={32} />}
        title="Missing repository context"
        description="Open this validation from the task view."
        action={
          <Button variant="secondary" onClick={() => navigate(ROUTES.tasks)}>
            Go to Tasks
          </Button>
        }
      />
    )
  }

  if (valLoading) {
    return (
      <div className={styles.emptyWrap}>
        <Spinner size={20} />
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <PageHeader
        breadcrumbs={[
          { label: 'Tasks', to: ROUTES.tasks },
          { label: 'Task', to: withRepo(routeTo.task(taskId)) },
          { label: 'Execution', to: withRepo(routeTo.taskExecution(taskId)) },
          { label: 'Validation' },
        ]}
        title="Validation"
        description={task?.intent}
        actions={
          run && (
            <StatusBadge
              map={EFFECTIVE_STATUS_MAP}
              status={effectiveStatus ?? run.status}
            />
          )
        }
      />

      {/* No run yet — validation starts automatically after execution */}
      {!run && (
        <div className={styles.emptyWrap}>
          <EmptyState
            icon={<Icon name="task" size={40} />}
            title="Validation not started"
            description={
              execSnap?.execution?.status === 'running'
                ? 'Execution is in progress. Validation will start automatically when it completes.'
                : 'Validation runs automatically after execution completes. No action needed.'
            }
            action={
              <Button
                variant="secondary"
                onClick={() => navigate(withRepo(routeTo.taskExecution(taskId)))}
              >
                View execution
              </Button>
            }
          />
        </div>
      )}

      {run && (
        <div className={styles.body}>
          {/* ── Left column ──────────────────────────────────────── */}
          <div className={styles.left}>
            {/* Overall result banner */}
            {run.overall_result && (
              <div
                className={`${styles.resultBanner} ${styles[run.overall_result] ?? ''}`}
              >
                <Icon
                  name={
                    run.overall_result === 'passed'
                      ? 'check'
                      : run.overall_result === 'failed_environment'
                        ? 'alert'
                        : run.overall_result === 'failed_requires_human'
                          ? 'alert'
                          : 'x'
                  }
                  size={16}
                />
                {resolveStatus(VALIDATION_OVERALL_RESULT, run.overall_result).label}
                {run.overall_result === 'failed_environment' && (
                  <span className={styles.resultNote}>
                    The code change may be correct. The project could not be validated because the execution environment could not reproduce the required runtime.
                  </span>
                )}
              </div>
            )}

            {/* Stage pipeline */}
            <Card padded={false}>
              <CardHeader
                title="Pipeline"
                subtitle={`${run.profile_id} · ${run.stack}`}
              />
              <div className={styles.stageList}>
                {stages.length === 0 && run.status === 'running' && (
                  <div style={{ padding: 'var(--space-4)', color: 'var(--text-tertiary)', display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <Spinner size={13} />
                    Preparing stages…
                  </div>
                )}
                {stages.map((stage) => {
                  const isSelected = selectedStage === stage.stage
                  const stageDiags = diagnostics.filter((d) => d.stage === stage.stage)
                  const stageErrors = stageDiags.filter((d) => d.severity === 'error').length
                  const stageWarns = stageDiags.filter((d) => d.severity === 'warning').length

                  return (
                    <div
                      key={stage.id}
                      className={`${styles.stageRow} ${isSelected ? styles.active : ''}`}
                      onClick={() =>
                        setSelectedStage(isSelected ? null : stage.stage)
                      }
                    >
                      <span className={styles.stageIcon}>
                        {STAGE_ICON[stage.stage] ?? '⚙️'}
                      </span>
                      <span className={styles.stageName}>{stage.stage}</span>
                      <div className={styles.stageMeta}>
                        {stageDuration(stage) && (
                          <span className={styles.stageDuration}>
                            {stageDuration(stage)}
                          </span>
                        )}
                        {(stageErrors > 0 || stageWarns > 0) && (
                          <span className={styles.stageCounts}>
                            {stageErrors > 0 && (
                              <span className={styles.errorCount}>
                                ✕{stageErrors}
                              </span>
                            )}
                            {stageWarns > 0 && (
                              <span className={styles.warnCount}>
                                ⚠{stageWarns}
                              </span>
                            )}
                          </span>
                        )}
                        <StatusBadge
                          map={VALIDATION_STAGE_STATUS}
                          status={stage.status}
                          size="sm"
                          dot={false}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>

            {/* Summary stats */}
            {(run.status === 'passed' || run.status === 'failed') && (
              <Card padded={false}>
                <CardHeader title="Summary" />
                <div className={styles.summaryGrid}>
                  <div className={styles.stat}>
                    <div className={`${styles.statValue} ${errorCount > 0 ? styles.danger : styles.success}`}>
                      {errorCount}
                    </div>
                    <div className={styles.statLabel}>errors</div>
                  </div>
                  <div className={styles.stat}>
                    <div className={`${styles.statValue} ${warnCount > 0 ? styles.warning : ''}`}>
                      {warnCount}
                    </div>
                    <div className={styles.statLabel}>warnings</div>
                  </div>
                  <div className={styles.stat}>
                    <div className={`${styles.statValue} ${autoFixable > 0 ? styles.success : ''}`}>
                      {autoFixable}
                    </div>
                    <div className={styles.statLabel}>auto-fixable</div>
                  </div>
                </div>
              </Card>
            )}
          </div>

          {/* ── Right column ─────────────────────────────────────── */}
          <div className={styles.right}>
            {/* Live activity log */}
            <Card padded={false}>
              <CardHeader
                title="Live activity"
                actions={
                  isActivityLive ? <Spinner size={13} /> : undefined
                }
              />
              <div className={styles.log}>
                <LogViewer
                  lines={logLines}
                  live={isActivityLive}
                  maxHeight={200}
                  emptyLabel={
                    isActivityLive
                      ? 'Waiting for events…'
                      : 'Validation complete.'
                  }
                />
              </div>
            </Card>

            {/* Stage command detail */}
            {selectedStage && (() => {
              const detail = stages.find((s) => s.stage === selectedStage)
              if (!detail) return null
              return (
                <Card padded={false}>
                  <CardHeader
                    title={`${STAGE_ICON[detail.stage] ?? '⚙️'} ${detail.stage}`}
                    actions={
                      <StatusBadge
                        map={VALIDATION_STAGE_STATUS}
                        status={detail.status}
                        size="sm"
                        dot={false}
                      />
                    }
                  />
                  <div className={styles.stageDetail}>
                    {detail.command && detail.command.length > 0 && (
                      <div className={styles.stageCommand}>
                        $ {detail.command.join(' ')}
                      </div>
                    )}
                    <LogViewer
                      lines={[
                        ...(detail.combined_output ?? detail.stdout ?? detail.stderr ?? '')
                          .split('\n')
                          .slice(0, 200)
                          .filter(Boolean)
                          .map((text, i) => ({
                            id: i,
                            text,
                            tone: text.toLowerCase().includes('error') ? 'error' as const
                              : text.toLowerCase().includes('warn') ? 'warning' as const
                              : 'default' as const,
                          })),
                      ]}
                      maxHeight={260}
                      emptyLabel="No output captured."
                    />
                  </div>
                </Card>
              )
            })()}

            {/* Diagnostics — grouped by category */}
            <Card padded={false}>
              <CardHeader
                title={selectedStage ? `Diagnostics — ${selectedStage}` : 'All diagnostics'}
                actions={
                  diagnostics.length > 0 ? (
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      {errorCount > 0 && (
                        <Badge tone="danger" size="sm">{errorCount} error{errorCount !== 1 ? 's' : ''}</Badge>
                      )}
                      {warnCount > 0 && (
                        <Badge tone="warning" size="sm">{warnCount} warning{warnCount !== 1 ? 's' : ''}</Badge>
                      )}
                    </div>
                  ) : undefined
                }
              />
              <div className={styles.diagList}>
                {visibleDiags.length === 0 ? (
                  <div className={styles.emptyDiag}>
                    {run.status === 'running'
                      ? 'Parsing diagnostics…'
                      : 'No diagnostics for this selection.'}
                  </div>
                ) : (
                  (() => {
                    // Group diagnostics into three buckets for clarity.
                    const infraCategories = new Set(['environment_error', 'dependency_missing'])
                    const appCategories = new Set(['compile_error', 'type_error', 'runtime_panic'])
                    const infra = visibleDiags.filter((d) => infraCategories.has(d.category))
                    const app = visibleDiags.filter((d) => appCategories.has(d.category))
                    const validation = visibleDiags.filter(
                      (d) => !infraCategories.has(d.category) && !appCategories.has(d.category),
                    )

                    const renderDiag = (d: ValidationDiagnostic) => (
                      <div key={d.id} className={styles.diagRow}>
                        <span className={`${styles.diagSev} ${styles[d.severity] ?? ''}`}>
                          {d.severity === 'error' ? '✕' : d.severity === 'warning' ? '⚠' : 'ℹ'}
                        </span>
                        <div className={styles.diagBody}>
                          <span className={styles.diagMessage} title={d.message}>
                            {d.message}
                          </span>
                          {(d.file_path || d.symbol_name) && (
                            <span className={styles.diagLocation}>
                              {[
                                d.file_path,
                                d.line_number ? `:${d.line_number}` : '',
                                d.symbol_name ? ` (${d.symbol_name})` : '',
                              ]
                                .filter(Boolean)
                                .join('')}
                            </span>
                          )}
                        </div>
                        <div className={styles.diagMeta}>
                          {d.repair_category && d.repair_category !== 'unknown' && (
                            <Badge
                              tone={d.repair_category === 'auto_fixable' ? 'info' : 'danger'}
                              size="sm"
                            >
                              {d.repair_category === 'auto_fixable' ? 'fixable' : 'manual'}
                            </Badge>
                          )}
                          <span className={styles.toolBadge}>{d.tool}</span>
                        </div>
                      </div>
                    )

                    return (
                      <>
                        {infra.length > 0 && (
                          <div className={styles.diagGroup}>
                            <div className={styles.diagGroupLabel}>Infrastructure</div>
                            {infra.map(renderDiag)}
                          </div>
                        )}
                        {app.length > 0 && (
                          <div className={styles.diagGroup}>
                            <div className={styles.diagGroupLabel}>Application</div>
                            {app.map(renderDiag)}
                          </div>
                        )}
                        {validation.length > 0 && (
                          <div className={styles.diagGroup}>
                            {(infra.length > 0 || app.length > 0) && (
                              <div className={styles.diagGroupLabel}>Validation</div>
                            )}
                            {validation.map(renderDiag)}
                          </div>
                        )}
                      </>
                    )
                  })()
                )}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

export default Validation
