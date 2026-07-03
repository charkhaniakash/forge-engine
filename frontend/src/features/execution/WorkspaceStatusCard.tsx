import {
  Button,
  Card,
  CardHeader,
  Icon,
  StatusBadge,
} from '@/components/common'
import {
  useDestroyWorkspaceMutation,
  useGetWorkspaceQuery,
  useProvisionWorkspaceMutation,
} from '@/services/api/workspaceApi'
import { useToast } from '@/hooks/useToast'
import { WORKSPACE_STATUS } from '@/constants/status'
import styles from './execution.module.css'

const TRANSIENT = new Set(['provisioning', 'executing', 'destroying'])

export interface WorkspaceStatusCardProps {
  repoId: string
  taskId: string
  /** Only allow provisioning once the plan is approved. */
  canProvision?: boolean
}

export function WorkspaceStatusCard({
  repoId,
  taskId,
  canProvision = true,
}: WorkspaceStatusCardProps) {
  const toast = useToast()
  const { data: workspace } = useGetWorkspaceQuery(
    { repoId, taskId },
    {
      skip: !repoId || !taskId,
      pollingInterval: 4000,
    },
  )
  const [provision, { isLoading: provisioning }] = useProvisionWorkspaceMutation()
  const [destroy, { isLoading: destroying }] = useDestroyWorkspaceMutation()

  const transient = TRANSIENT.has(workspace?.status ?? '')
  const active =
    workspace && !['destroyed', 'failed', 'killed', 'timed_out'].includes(workspace.status)

  async function onProvision() {
    try {
      await provision({ repoId, taskId }).unwrap()
      toast.info('Provisioning workspace…')
    } catch {
      toast.error('Failed to provision workspace')
    }
  }

  async function onDestroy() {
    try {
      await destroy({ repoId, taskId }).unwrap()
      toast.info('Destroying workspace…')
    } catch {
      toast.error('Failed to destroy workspace')
    }
  }

  return (
    <Card padded={false}>
      <CardHeader
        title="Workspace"
        actions={<StatusBadge map={WORKSPACE_STATUS} status={workspace?.status} />}
      />
      <div className={styles.wsBody}>
        {!workspace ? (
          <div className={styles.wsEmpty}>
            <span>No workspace provisioned.</span>
            <Button
              size="sm"
              variant="primary"
              onClick={onProvision}
              loading={provisioning}
              disabled={!canProvision}
              leadingIcon={<Icon name="plus" size={14} />}
            >
              Provision
            </Button>
          </div>
        ) : (
          <>
            <WsRow label="Container" value={workspace.container_name ?? '—'} mono />
            <WsRow label="Image" value={workspace.image} mono />
            <WsRow label="Commit" value={workspace.commit_sha.slice(0, 7)} mono />
            <WsRow
              label="Resources"
              value={`${workspace.cpu_limit} CPU · ${workspace.memory_limit_mb} MB`}
            />
            {workspace.error && <div className={styles.wsError}>{workspace.error}</div>}
            <div className={styles.wsActions}>
              {active && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={onDestroy}
                  loading={destroying}
                  disabled={transient}
                >
                  Destroy
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

function WsRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.wsRow}>
      <span className={styles.wsLabel}>{label}</span>
      <span className={mono ? styles.wsMono : undefined}>{value}</span>
    </div>
  )
}
