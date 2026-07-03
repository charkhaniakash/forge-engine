import { Icon } from '@/components/common'
import styles from './execution.module.css'

export interface ToolCallCardProps {
  tool: string
  args?: Record<string, unknown>
  success?: boolean
  result?: string
}

/** A single tool invocation within a step's event trace. */
export function ToolCallCard({ tool, args, success, result }: ToolCallCardProps) {
  return (
    <div className={styles.toolCall}>
      <div className={styles.toolHead}>
        <Icon name="tool" size={13} className={styles.toolIcon} />
        <code className={styles.toolName}>{tool}</code>
        {success != null && (
          <span className={success ? styles.ok : styles.fail}>
            <Icon name={success ? 'check' : 'x'} size={12} />
          </span>
        )}
      </div>
      {args && Object.keys(args).length > 0 && (
        <pre className={styles.toolArgs}>{JSON.stringify(args, null, 2)}</pre>
      )}
      {result && <pre className={styles.toolResult}>{result}</pre>}
    </div>
  )
}
