'use client'

import { useEffect, useState } from 'react'
import { Plus, Trash2, Copy, Check, RefreshCw, Webhook, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'

// ── types ────────────────────────────────────────────────────
interface WebhookEndpoint {
  id: string
  url: string
  events: string[]
  is_active: boolean
  last_delivery_at: string | null
  failure_count: number
  created_at: string
  secret?: string // only present right after creation
}

const ALL_EVENTS = [
  { value: 'message.received', label: 'Message Received', description: 'Every inbound WhatsApp message from a contact' },
  { value: 'message.status_updated', label: 'Message Status Updated', description: 'Sent message changed status (sent/delivered/read/failed)' },
  { value: 'conversation.created', label: 'Conversation Created', description: 'A new conversation thread was opened' },
] as const

// ── helpers ──────────────────────────────────────────────────
function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── sub-components ───────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Button variant="outline" size="sm" onClick={copy} className="shrink-0">
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="ml-1.5">{copied ? 'Copied' : 'Copy'}</span>
    </Button>
  )
}

function SecretBanner({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
            Save your signing secret — it won&apos;t be shown again
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Use this to verify the <code className="font-mono">X-Wacrm-Signature</code> header on incoming deliveries.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-3 py-2 font-mono text-xs text-foreground">
              {secret}
            </code>
            <CopyButton text={secret} />
          </div>
          <Button variant="ghost" size="sm" className="mt-2 h-7 text-xs text-muted-foreground" onClick={onDismiss}>
            I&apos;ve saved it, dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}

function EndpointCard({
  endpoint,
  onDelete,
  onToggle,
  onUpdate,
}: {
  endpoint: WebhookEndpoint
  onDelete: (id: string) => void
  onToggle: (id: string, active: boolean) => void
  onUpdate: (id: string, url: string, events: string[]) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editUrl, setEditUrl] = useState(endpoint.url)
  const [editEvents, setEditEvents] = useState<string[]>(endpoint.events)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [newSecret, setNewSecret] = useState<string | null>(null)

  const dirty = editUrl !== endpoint.url || JSON.stringify([...editEvents].sort()) !== JSON.stringify([...endpoint.events].sort())

  const save = async () => {
    setSaving(true)
    await onUpdate(endpoint.id, editUrl, editEvents)
    setSaving(false)
    setExpanded(false)
  }

  const handleDelete = async () => {
    if (!confirm('Delete this webhook endpoint? This cannot be undone.')) return
    setDeleting(true)
    onDelete(endpoint.id)
  }

  const toggleEvent = (ev: string) => {
    setEditEvents((prev) =>
      prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]
    )
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Header row */}
      <div className="flex items-center gap-3 p-4">
        <Switch
          checked={endpoint.is_active}
          onCheckedChange={(v) => onToggle(endpoint.id, v)}
        />
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{endpoint.url}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            {endpoint.events.map((ev) => (
              <Badge key={ev} variant="secondary" className="text-xs">
                {ev}
              </Badge>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {endpoint.failure_count > 0 && (
            <p className="text-xs text-red-500">{endpoint.failure_count} failure{endpoint.failure_count !== 1 ? 's' : ''}</p>
          )}
          {endpoint.last_delivery_at && (
            <p className="text-xs text-muted-foreground">Last: {timeAgo(endpoint.last_delivery_at)}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 h-8 w-8"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </div>

      {/* Secret banner (shown after re-roll, future feature placeholder) */}
      {newSecret && (
        <div className="px-4 pb-3">
          <SecretBanner secret={newSecret} onDismiss={() => setNewSecret(null)} />
        </div>
      )}

      {/* Expanded edit form */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Endpoint URL</Label>
            <Input
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              placeholder="https://your-server.com/webhook"
              className="border-border bg-muted text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Events to send</Label>
            <div className="space-y-2">
              {ALL_EVENTS.map((ev) => (
                <label
                  key={ev.value}
                  className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={editEvents.includes(ev.value)}
                    onChange={() => toggleEvent(ev.value)}
                    className="mt-0.5 accent-primary"
                  />
                  <div>
                    <p className="text-sm font-medium text-foreground">{ev.label}</p>
                    <p className="text-xs text-muted-foreground">{ev.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={save}
              disabled={saving || !dirty || editEvents.length === 0}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setEditUrl(endpoint.url); setEditEvents(endpoint.events); setExpanded(false) }}
            >
              Cancel
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
              onClick={handleDelete}
              disabled={deleting}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function AddEndpointForm({ onCreated }: { onCreated: (ep: WebhookEndpoint) => void }) {
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>(['message.received'])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleEvent = (ev: string) => {
    setEvents((prev) => prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev])
  }

  const submit = async () => {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/internal/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, events }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to create webhook')
      onCreated(json.data)
      setUrl('')
      setEvents(['message.received'])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Add webhook endpoint</h3>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-muted-foreground">Endpoint URL <span className="text-red-400">*</span></Label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-server.com/webhook"
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <p className="text-xs text-muted-foreground">Must be a public <code className="font-mono">https://</code> URL</p>
      </div>

      <div className="space-y-2">
        <Label className="text-muted-foreground">Events to receive</Label>
        <div className="space-y-2">
          {ALL_EVENTS.map((ev) => (
            <label
              key={ev.value}
              className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
            >
              <input
                type="checkbox"
                checked={events.includes(ev.value)}
                onChange={() => toggleEvent(ev.value)}
                className="mt-0.5 accent-primary"
              />
              <div>
                <p className="text-sm font-medium text-foreground">{ev.label}</p>
                <p className="text-xs text-muted-foreground">{ev.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <Button
        onClick={submit}
        disabled={loading || !url || events.length === 0}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {loading ? (
          <>
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            Creating…
          </>
        ) : (
          <>
            <Plus className="mr-2 h-4 w-4" />
            Add endpoint
          </>
        )}
      </Button>
    </div>
  )
}

// ── main component ───────────────────────────────────────────
export function WebhookSettings() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newSecret, setNewSecret] = useState<string | null>(null)

  const fetchEndpoints = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/internal/webhooks')
      const json = await res.json()
      setEndpoints(json.data ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchEndpoints() }, [])

  const handleCreated = (ep: WebhookEndpoint) => {
    if (ep.secret) setNewSecret(ep.secret)
    setEndpoints((prev) => [{ ...ep, secret: undefined }, ...prev])
    setShowAdd(false)
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/internal/webhooks/${id}`, { method: 'DELETE' })
    setEndpoints((prev) => prev.filter((e) => e.id !== id))
  }

  const handleToggle = async (id: string, active: boolean) => {
    setEndpoints((prev) => prev.map((e) => e.id === id ? { ...e, is_active: active } : e))
    await fetch(`/api/internal/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: active }),
    })
  }

  const handleUpdate = async (id: string, url: string, events: string[]) => {
    const res = await fetch(`/api/internal/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, events }),
    })
    const json = await res.json()
    if (res.ok) {
      setEndpoints((prev) => prev.map((e) => e.id === id ? json.data : e))
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Webhook className="h-5 w-5 text-primary" />
            Webhooks
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            WhatsApp Max will POST a signed JSON payload to your URL for every subscribed event.
          </p>
        </div>
        {!showAdd && (
          <Button
            size="sm"
            onClick={() => setShowAdd(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add endpoint
          </Button>
        )}
      </div>

      {/* One-time secret banner */}
      {newSecret && (
        <SecretBanner secret={newSecret} onDismiss={() => setNewSecret(null)} />
      )}

      {/* Add form */}
      {showAdd && (
        <div>
          <AddEndpointForm onCreated={handleCreated} />
          <Button variant="ghost" size="sm" className="mt-2 text-muted-foreground" onClick={() => setShowAdd(false)}>
            Cancel
          </Button>
        </div>
      )}

      {/* Endpoint list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-20 rounded-lg border border-border bg-muted animate-pulse" />
          ))}
        </div>
      ) : endpoints.length === 0 ? (
        !showAdd && (
          <div className="rounded-lg border border-dashed border-border py-12 text-center">
            <Webhook className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-3 text-sm font-medium text-foreground">No webhook endpoints yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add an endpoint to start receiving events for every inbound message and status update.
            </p>
            <Button
              size="sm"
              className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => setShowAdd(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add your first endpoint
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {endpoints.map((ep) => (
            <EndpointCard
              key={ep.id}
              endpoint={ep}
              onDelete={handleDelete}
              onToggle={handleToggle}
              onUpdate={handleUpdate}
            />
          ))}
        </div>
      )}

      {/* Payload reference
      {endpoints.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-2">
          <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Example payload — message.received</p>
          <pre className="text-xs text-muted-foreground overflow-x-auto">{`{
  "id": "uuid-per-delivery",
  "event": "message.received",
  "occurred_at": "2025-01-01T12:00:00.000Z",
  "account_id": "your-account-id",
  "data": {
    "conversation_id": "...",
    "contact_id": "...",
    "whatsapp_message_id": "wamid.xxx",
    "content_type": "text",
    "text": "Hello!"
  }
}`}</pre>
          <p className="text-xs text-muted-foreground">
            Verify with the <code className="font-mono">X-Wacrm-Signature</code> header using your signing secret.
          </p>
        </div>
      )} */}
    </div>
  )
}