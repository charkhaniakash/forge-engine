import { Button, Icon } from '@/components/common'
import { useAppSelector } from '@/app/hooks'
import {
  usePauseExecutionMutation,
  useResumeExecutionMutation,
  useStopExecutionMutation,
} from '@/services/api/workspaceEditorApi'
import { useToast } from '@/hooks/useToast'
import styles from './workspace.module.css'

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
    <div className={styles.collab}>
      <span className={styles.collabLabel}>
        {collab.label ?? STATUS_LABEL[status] ?? 'Idle'}
      </span>
      {running && (
        <Button size="sm" variant="ghost" loading={pausing}
          leadingIcon={<Icon name="clock" size={13} />}
          onClick={() => run(() => pause(workspaceId).unwrap(), 'Paused')}>
          Pause
        </Button>
      )}
      {paused && (
        <Button size="sm" variant="ghost" loading={resuming}
          leadingIcon={<Icon name="play" size={13} />}
          onClick={() => run(() => resume(workspaceId).unwrap(), 'Resumed')}>
          Resume
        </Button>
      )}
      {active && (
        <Button size="sm" variant="danger" loading={stopping}
          leadingIcon={<Icon name="x" size={13} />}
          onClick={() => run(() => stop(workspaceId).unwrap(), 'Stopped')}>
          Stop
        </Button>
      )}
    </div>
  )
}
