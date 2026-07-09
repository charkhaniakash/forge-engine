import type { LifecyclePhase, PhaseState } from './model'
import styles from './LifecycleTimeline.module.css'

export interface LifecycleTimelineProps {
  phases: LifecyclePhase[]
  activeKey?: string
  onSelect?: (phase: LifecyclePhase) => void
}

function phaseKey(p: LifecyclePhase): string {
  return p.attempt != null ? `${p.kind}-${p.attempt}` : p.kind
}

const GLYPH: Record<PhaseState, string> = {
  passed: '✓',
  failed: '✗',
  active: '',
  pending: '',
  skipped: '–',
}

/**
 * Vertical lifecycle rail: Created → Planning → Executing → Validation →
 * Repair (one node per attempt) → Completed. Reflects live phase state and
 * lets the user jump to a phase's detail. Repair attempts stack in-line here
 * rather than living on separate pages.
 */
export function LifecycleTimeline({ phases, activeKey, onSelect }: LifecycleTimelineProps) {
  return (
    <ol className={styles.rail}>
      {phases.map((p, i) => {
        const key = phaseKey(p)
        const isActive = key === activeKey
        return (
          <li key={key} className={styles.item}>
            <div className={styles.gutter}>
              <span
                className={`${styles.node} ${styles[`state_${p.state}`]} ${
                  p.state === 'active' ? styles.pulse : ''
                }`}
              >
                {p.state === 'active' ? <span className={styles.dot} /> : GLYPH[p.state]}
              </span>
              {i < phases.length - 1 && (
                <span className={`${styles.connector} ${p.state === 'passed' ? styles.connectorDone : ''}`} />
              )}
            </div>
            <button
              type="button"
              className={`${styles.label} ${isActive ? styles.labelActive : ''}`}
              onClick={() => onSelect?.(p)}
            >
              <span className={styles.name}>{p.label}</span>
              {p.hint && <span className={styles.hint}>{p.hint}</span>}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
