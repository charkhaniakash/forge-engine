import { useNavigate } from 'react-router-dom'
import { Button, EmptyState, Icon, PlaceholderPage } from '@/components/common'
import { ROUTES } from '@/constants/routes'

export function BuildTest() {
  return (
    <PlaceholderPage
      title="Build & Test"
      phase="Phase 8"
      icon="build"
      description="Compile, run test suites, and gate execution on green builds."
      features={[
        'Automated build & test runs per execution',
        'Test result timelines and failure diffs',
        'Coverage and flake tracking',
      ]}
    />
  )
}

export function Repairs() {
  return (
    <PlaceholderPage
      title="Repairs"
      phase="Phase 9"
      icon="repair"
      description="Self-healing loop that diagnoses failures and proposes fixes."
      features={[
        'Automatic failure diagnosis',
        'Repair attempts with before/after diffs',
        'Repair history per step',
      ]}
    />
  )
}

export function Git() {
  return (
    <PlaceholderPage
      title="Git"
      phase="Phase 10"
      icon="git"
      description="Commit changes and open pull requests from completed executions."
      features={['Commit grouping by step', 'Pull request creation & status', 'Branch management']}
    />
  )
}

export function WorkspacePlaceholder() {
  return (
    <PlaceholderPage
      title="Workspace"
      phase="Phase 10B"
      icon="workspace"
      description="A full browser IDE backed by the live execution sandbox."
      features={['File tree & code editor', 'Integrated terminal', 'Live container inspection']}
    />
  )
}

export function Audit() {
  return (
    <PlaceholderPage
      title="Audit"
      phase="Phase 13"
      icon="audit"
      description="Full execution history, cost accounting, and trace inspection."
      features={['Execution & cost history', 'LLM token usage', 'Audit logs and trace viewer']}
    />
  )
}

export function Usage() {
  return (
    <PlaceholderPage
      title="Usage"
      phase="Phase 13"
      icon="usage"
      description="Track consumption and spend across the organization."
      features={['Per-repo and per-task usage', 'Model spend breakdown', 'Quotas and limits']}
    />
  )
}

export function NotFound() {
  const navigate = useNavigate()
  return (
    <EmptyState
      icon={<Icon name="alert" size={40} />}
      title="Page not found"
      description="The page you're looking for doesn't exist."
      action={
        <Button variant="primary" onClick={() => navigate(ROUTES.dashboard)}>
          Go to dashboard
        </Button>
      }
    />
  )
}
