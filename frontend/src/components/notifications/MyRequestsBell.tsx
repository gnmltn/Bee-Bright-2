import { Bell, ChevronRight, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMyRequests, categoryLabel, STATUS_LABEL, STATUS_TONE, formatWhen } from '@/lib/escalations';

/**
 * Read-only status view of the signed-in user's own support requests (Task 16 / 18).
 * Used by parents and tutors in their dashboard. Filters strictly to the caller's
 * own tickets server-side (`GET /api/escalations/mine`). No replying from here.
 *
 * `asRow` renders it to match a "Quick Actions" list row; otherwise a plain icon button.
 */
export function MyRequestsBell({ asRow = false }: { asRow?: boolean }) {
  const { items, loading, error, unreadCount, markSeen } = useMyRequests();

  const onOpenChange = (open: boolean) => {
    if (open) markSeen();
  };

  const Dot = unreadCount > 0 ? (
    <span
      className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5"
      aria-label={`${unreadCount} unread update${unreadCount === 1 ? '' : 's'}`}
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
    </span>
  ) : null;

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {asRow ? (
          <button
            type="button"
            className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted transition-colors text-left"
          >
            <div className="flex items-center gap-3">
              <span className="relative">
                <Bell className="h-4 w-4 text-primary" />
                {Dot}
              </span>
              <span className="text-sm text-muted-foreground">My Requests</span>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="My requests"
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <Bell className="h-5 w-5" />
            {Dot}
          </button>
        )}
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">My Requests</p>
          <p className="text-xs text-muted-foreground">
            Status of the help requests you've raised with the assistant.
          </p>
        </div>

        <ScrollArea className="max-h-80">
          <div className="p-2">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : error ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Couldn't load your requests. Try again in a bit.
              </p>
            ) : items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                You have no requests. When you ask the assistant for a person, or it can't
                answer something, it'll show up here.
              </p>
            ) : (
              <ul className="space-y-1">
                {items.map((e) => (
                  <li key={e._id} className="rounded-lg px-3 py-2.5 hover:bg-muted/60">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-sm font-medium text-foreground">
                        {categoryLabel(e.category)}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[e.status]}`}
                      >
                        {STATUS_LABEL[e.status]}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Raised {formatWhen(e.createdAt)}
                      {e.status !== 'open' && e.updatedAt !== e.createdAt
                        ? ` · updated ${formatWhen(e.updatedAt)}`
                        : ''}
                    </p>
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
