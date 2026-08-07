import { Icon, Spinner } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useAppSelector } from '@/app/hooks'
import {
  usePauseExecutionMutation,
  useResumeExecutionMutation,
  useStopExecutionMutation,
} from '@/services/api/workspaceEditorApi'
import { useToast } from '@/hooks/useToast'

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Completed',
  idle: 'Idle',
}

export function CollaborationBar({ workspaceId }: { workspaceId: string }) {
  const toast = useToast()
  const collab = useAppSelector((s) => s.workspaceActivity.collaboration)
  const [pause, { isLoading: pausing }] = usePauseExecutionMutation()
  const [resume, { isLoading: resuming }] = useResumeExecutionMutation()
  const [stop, { isLoading: stopping }] = useStopExecutionMutation()

  const status = collab.status
  const running = status === 'running'
  const paused = status === 'paused'
  const active = running || paused

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      toast.success(ok)
    } catch {
      toast.error('Action failed')
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-xs font-medium text-fg-muted">
        {collab.label ?? STATUS_LABEL[status] ?? 'Idle'}
      </span>
      {running && (
        <Button size="sm" variant="ghost" disabled={pausing} onClick={() => run(() => pause(workspaceId).unwrap(), 'Paused')}>
          {pausing ? <Spinner size={13} /> : <Icon name="clock" size={13} />} Pause
        </Button>
      )}
      {paused && (
        <Button size="sm" variant="ghost" disabled={resuming} onClick={() => run(() => resume(workspaceId).unwrap(), 'Resumed')}>
          {resuming ? <Spinner size={13} /> : <Icon name="play" size={13} />} Resume
        </Button>
      )}
      {active && (
        <Button size="sm" variant="destructive" disabled={stopping} onClick={() => run(() => stop(workspaceId).unwrap(), 'Stopped')}>
          {stopping ? <Spinner size={13} /> : <Icon name="x" size={13} />} Stop
        </Button>
      )}
    </div>
  )
}
