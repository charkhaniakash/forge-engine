import { Icon } from '@/components/common'
import styles from './execution.module.css'

export interface ReasoningPanelProps {
  reasoning?: string
}

export function ReasoningPanel({ reasoning }: ReasoningPanelProps) {
  if (!reasoning) return null
  return (
    <div className={styles.reasoning}>
      <div className={styles.blockHead}>
        <Icon name="chat" size={14} /> Reasoning
      </div>
      <p className={styles.reasoningText}>{reasoning}</p>
    </div>
  )
}
