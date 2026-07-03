import { Button, Icon, StatusBadge } from '@/components/common'
import { APPROVAL_STATUS } from '@/constants/status'
import styles from './ApprovalPanel.module.css'

export interface ApprovalPanelProps {
  approvalStatus: string
  canApprove: boolean
  approving: boolean
  rejecting: boolean
  replanning: boolean
  onApprove: () => void
  onReject: () => void
  onReplan: () => void
}

/** Sticky action bar for approving / rejecting / re-planning a draft plan. */
export function ApprovalPanel({
  approvalStatus,
  canApprove,
  approving,
  rejecting,
  replanning,
  onApprove,
  onReject,
  onReplan,
}: ApprovalPanelProps) {
  const decided = approvalStatus === 'approved' || approvalStatus === 'rejected'
  return (
    <div className={styles.bar}>
      <div className={styles.status}>
        <span className={styles.label}>Approval</span>
        <StatusBadge map={APPROVAL_STATUS} status={approvalStatus} />
      </div>
      <div className={styles.actions}>
        <Button
          variant="ghost"
          onClick={onReplan}
          loading={replanning}
          leadingIcon={<Icon name="refresh" size={15} />}
        >
          Re-plan
        </Button>
        <Button
          variant="danger"
          onClick={onReject}
          loading={rejecting}
          disabled={decided}
          leadingIcon={<Icon name="x" size={15} />}
        >
          Reject
        </Button>
        <Button
          variant="primary"
          onClick={onApprove}
          loading={approving}
          disabled={!canApprove || decided}
          leadingIcon={<Icon name="check" size={15} />}
        >
          Approve plan
        </Button>
      </div>
    </div>
  )
}
