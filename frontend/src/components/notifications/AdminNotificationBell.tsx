import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Loader2, ShieldAlert } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/hooks/useAuth';
import { escalationService, type AdminEscalation } from '@/services/api';
import { categoryLabel, formatWhen } from '@/lib/escalations';

/**
 * Admin / super_admin new-request alert (Task 17). Polls open escalations; badge shows
 * the open count. Clicking a row opens that request on the Support Requests page
 * (Task 11) — same data, one implementation. Read + acknowledge/resolve happen there.
 */
export function AdminNotificationBell() {
  const { user } = useAuth();
  const base = user?.role === 'super_admin' ? '/super-admin-dashboard' : '/admin-dashboard';
  const [open, setOpen] = useState<AdminEscalation[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [listRes, statsRes] = await Promise.all([
        escalationService.list({ status: 'open', limit: 12 }),
        escalationService.getStats(),
      ]);
      if (listRes.data?.success) setOpen(listRes.data.escalations || []);
      if (statsRes.data?.success) setCount(statsRes.data.stats.openOrAcknowledged);
    } catch {
      /* leave last-known values */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 60000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? `${count} open request${count === 1 ? '' : 's'}` : 'Support requests'}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {count > 9 ? '9+' : count}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Support Requests</p>
          <Link to={`${base}/escalations`} className="text-xs font-medium text-primary hover:underline">
            View all
          </Link>
        </div>

        <ScrollArea className="max-h-80">
          <div className="p-2">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : open.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No open requests. Nice.
              </p>
            ) : (
              <ul className="space-y-1">
                {open.map((e) => (
                  <li key={e._id}>
                    <Link
                      to={`${base}/escalations?focus=${e._id}`}
                      className={`block rounded-lg px-3 py-2.5 hover:bg-muted/60 ${e.source === 'child_safety' ? 'bg-destructive/5' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        {e.source === 'child_safety' && <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />}
                        <span className="text-sm font-medium text-foreground">{categoryLabel(e.category)}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {e.user
                          ? [e.user.firstName, e.user.lastName].filter(Boolean).join(' ') || e.user.email
                          : e.userIdentifier || 'Anonymous visitor'}
                        {' · '}{formatWhen(e.createdAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
