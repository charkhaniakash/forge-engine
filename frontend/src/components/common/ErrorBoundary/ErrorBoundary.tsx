import { Component, type ErrorInfo, type ReactNode } from 'react'
import { EmptyState } from '../EmptyState/EmptyState'
import { Button } from '../Button/Button'
import { Icon } from '../Icon/Icon'

interface Props {
  children: ReactNode
  /** Optional custom fallback renderer. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/** Catches render errors in a subtree and shows a recoverable fallback. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return (
      <EmptyState
        icon={<Icon name="alert" size={32} />}
        title="Something went wrong"
        description={error.message}
        action={
          <Button variant="secondary" onClick={this.reset}>
            Try again
          </Button>
        }
      />
    )
  }
}
