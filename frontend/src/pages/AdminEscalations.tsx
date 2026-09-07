import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { escalationService, type AdminEscalation, type EscalationStatus } from '@/services/api';
import { categoryLabel, STATUS_LABEL, STATUS_TONE, formatWhen } from '@/lib/escalations';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Being handled' },
  { value: 'resolved', label: 'Resolved' },
];

const REASON_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All reasons' },
  { value: 'child_safety', label: 'Safety flag' },
  { value: 'human_requested', label: 'Talk to a person' },
  { value: 'billing_dispute', label: 'Billing concern' },
  { value: 'complaint', label: 'Complaint' },
  { value: 'repeated_no_match', label: "Couldn't answer" },
];

function requesterName(e: AdminEscalation): string {
  if (e.user) {
    const n = [e.user.firstName, e.user.lastName].filter(Boolean).join(' ').trim();
    if (n) return n;
    if (e.user.email) return e.user.email;
  }
  return e.userIdentifier || 'Anonymous visitor';
}

export default function AdminEscalations() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<AdminEscalation[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>(params.get('status') || 'open');
  const [reason, setReason] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(params.get('focus'));
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query: Record<string, string> = {};
      if (status !== 'all') query.status = status as EscalationStatus;
      if (reason !== 'all') {
        if (reason === 'child_safety') query.source = 'child_safety';
        else query.category = reason;
      }
      const res = await escalationService.list(query);
      if (res.data?.success) setRows(res.data.escalations || []);
    } catch {
      toast({ title: 'Could not load requests', description: 'Please try again.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [status, reason, toast]);

  useEffect(() => { load(); }, [load]);

  // Safety flags are already sorted to the top by the API; keep that order.
  const ordered = useMemo(() => rows, [rows]);

  const setRowStatus = async (id: string, next: EscalationStatus) => {
    setBusyId(id);
    try {
      const res = await escalationService.update(id, { status: next });
      if (res.data?.success) {
        setRows((cur) => cur.map((r) => (r._id === id ? { ...r, ...res.data.escalation } : r)));
        toast({ title: `Marked ${STATUS_LABEL[next].toLowerCase()}` });
      }
    } catch {
      toast({ title: 'Update failed', description: 'Please try again.', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const changeStatusFilter = (v: string) => {
    setStatus(v);
    const p = new URLSearchParams(params);
    if (v === 'open') p.delete('status'); else p.set('status', v);
    p.delete('focus');
    setParams(p, { replace: true });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-foreground">Support Requests</h1>
            <p className="text-sm text-muted-foreground">
              Conversations the assistant flagged for a person to follow up on. Safety flags are shown first.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <div className="flex flex-wrap gap-3">
          <Select value={status} onValueChange={changeStatusFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              {REASON_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-xl border border-border bg-card">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : ordered.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No requests match these filters.</p>
          ) : (
            <ul className="divide-y divide-border">
              {ordered.map((e) => {
                const isSafety = e.source === 'child_safety';
                const isOpen = expanded === e._id;
                return (
                  <li key={e._id} className={isSafety ? 'bg-destructive/5' : ''}>
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : e._id)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50"
                    >
                      {isOpen ? <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                        : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {isSafety && <ShieldAlert className="h-4 w-4 text-destructive" />}
                          <span className="font-medium text-foreground">{categoryLabel(e.category)}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[e.status]}`}>
                            {STATUS_LABEL[e.status]}
                          </span>
                          {e.severity === 'urgent' && !isSafety && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-destructive">
                              <AlertTriangle className="h-3 w-3" /> Urgent
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {requesterName(e)}{e.role ? ` · ${e.role}` : ''} · {formatWhen(e.createdAt)}
                        </p>
                      </div>
                    </button>

                    {isOpen && (
                      <div className="space-y-4 border-t border-border bg-muted/30 px-4 py-4 pl-11">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Requester" value={requesterName(e)} />
                          <Field label="Email" value={e.user?.email || e.userIdentifier || '—'} copyable />
                          {e.user?.phone && <Field label="Phone" value={e.user.phone} copyable />}
                          <Field label="Role" value={e.role || e.user?.role || 'public'} />
                          <Field label="Raised" value={new Date(e.createdAt).toLocaleString('en-PH')} />
                          {e.handledBy && (
                            <Field
                              label="Handled by"
                              value={[e.handledBy.firstName, e.handledBy.lastName].filter(Boolean).join(' ') || e.handledBy.email || '—'}
                            />
                          )}
                        </div>

                        {e.conversationSnippet && (
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Conversation snippet
                            </p>
                            <p className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-card p-3 text-sm text-foreground">
                              {e.conversationSnippet}
                            </p>
                          </div>
                        )}

                        <p className="text-xs text-muted-foreground">
                          Follow up with the requester by email yourself, then update the status here.
                        </p>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId === e._id || e.status === 'acknowledged' || e.status === 'resolved'}
                            onClick={() => setRowStatus(e._id, 'acknowledged')}
                          >
                            Mark as acknowledged
                          </Button>
                          <Button
                            size="sm"
                            disabled={busyId === e._id || e.status === 'resolved'}
                            onClick={() => setRowStatus(e._id, 'resolved')}
                          >
                            {busyId === e._id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Mark as resolved'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}

function Field({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const { toast } = useToast();
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <button
        type={copyable ? 'button' : undefined}
        onClick={copyable ? () => {
          navigator.clipboard?.writeText(value).then(
            () => toast({ title: 'Copied' }),
            () => undefined,
          );
        } : undefined}
        className={`mt-0.5 block max-w-full truncate text-sm text-foreground ${copyable ? 'hover:text-primary hover:underline' : 'cursor-default'}`}
        title={copyable ? 'Click to copy' : undefined}
      >
        {value}
      </button>
    </div>
  );
}
