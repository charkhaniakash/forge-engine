import { useState, type FormEvent } from 'react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  Modal,
  PageHeader,
  Skeleton,
} from '@/components/common'
import {
  useCreateOrgMutation,
  useInviteMemberMutation,
  useListMembersQuery,
  useListOrgsQuery,
} from '@/services/api/organizationApi'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import type { Role } from '@/types'
import styles from './Organizations.module.css'

const ROLES: Role[] = ['member', 'admin', 'owner']

export function Organizations() {
  const { org: activeOrg } = useAuth()
  const toast = useToast()
  const { data: orgs, isLoading } = useListOrgsQuery()
  const [picked, setPicked] = useState<string | null>(null)
  // Fall back to the active org (then the first) until the user picks one —
  // derived rather than synced via an effect.
  const selectedId = picked ?? activeOrg?.id ?? orgs?.[0]?.id ?? null
  const setSelectedId = setPicked

  const [createOrg, { isLoading: creating }] = useCreateOrgMutation()
  const [invite, { isLoading: inviting }] = useInviteMemberMutation()

  const [showCreate, setShowCreate] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [orgName, setOrgName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('member')

  const { data: members, isLoading: membersLoading } = useListMembersQuery(selectedId ?? '', {
    skip: !selectedId,
  })

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    try {
      await createOrg({ name: orgName.trim() }).unwrap()
      toast.success('Organization created')
      setShowCreate(false)
      setOrgName('')
    } catch {
      toast.error('Failed to create organization')
    }
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault()
    if (!selectedId) return
    try {
      await invite({ orgId: selectedId, email: inviteEmail.trim(), role: inviteRole }).unwrap()
      toast.success('Invitation sent')
      setShowInvite(false)
      setInviteEmail('')
    } catch {
      toast.error('Failed to invite member')
    }
  }

  return (
    <div>
      <PageHeader
        title="Organizations"
        description="Manage organizations and their members."
        actions={
          <Button variant="primary" leadingIcon={<Icon name="plus" size={15} />} onClick={() => setShowCreate(true)}>
            New organization
          </Button>
        }
      />

      <div className={styles.body}>
        <div className={styles.list}>
          {isLoading && <Skeleton height={56} />}
          {orgs?.map((o) => (
            <Card key={o.id} interactive onClick={() => setSelectedId(o.id)}>
              <div className={styles.orgRow}>
                <Icon name="org" size={18} />
                <span className={styles.orgName}>{o.name}</span>
                {o.id === activeOrg?.id && <Badge tone="accent" size="sm">Current</Badge>}
                {o.id === selectedId && <Icon name="check" size={15} className={styles.check} />}
              </div>
            </Card>
          ))}
        </div>

        <Card padded={false} className={styles.membersCard}>
          <CardHeader
            title="Members"
            actions={
              <Button size="sm" variant="secondary" onClick={() => setShowInvite(true)} disabled={!selectedId}>
                Invite
              </Button>
            }
          />
          <div className={styles.members}>
            {membersLoading && <div className={styles.pad}><Skeleton height={40} /></div>}
            {!membersLoading && (members?.length ?? 0) === 0 && (
              <EmptyState compact icon={<Icon name="org" size={28} />} title="No members" />
            )}
            {members?.map((m) => (
              <div key={m.id} className={styles.memberRow}>
                <div className={styles.avatar}>{m.name?.[0]?.toUpperCase() ?? '?'}</div>
                <div className={styles.memberMain}>
                  <div className={styles.memberName}>{m.name}</div>
                  <div className={styles.memberEmail}>{m.email}</div>
                </div>
                <Badge tone="neutral" size="sm">{m.role}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New organization"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button variant="primary" onClick={onCreate} loading={creating} disabled={!orgName.trim()}>Create</Button>
          </>
        }
      >
        <form onSubmit={onCreate}>
          <label className={styles.fieldLabel}>Name</label>
          <input
            className={styles.input}
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Acme Inc."
            autoFocus
          />
        </form>
      </Modal>

      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Invite member"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button variant="primary" onClick={onInvite} loading={inviting} disabled={!inviteEmail.trim()}>Send invite</Button>
          </>
        }
      >
        <form onSubmit={onInvite} className={styles.inviteForm}>
          <div>
            <label className={styles.fieldLabel}>Email</label>
            <input
              className={styles.input}
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com"
              autoFocus
            />
          </div>
          <div>
            <label className={styles.fieldLabel}>Role</label>
            <select className={styles.input} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </form>
      </Modal>
    </div>
  )
}

export default Organizations
