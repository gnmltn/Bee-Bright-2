import { useEffect, useState } from "react";
import { Loader2, Check, X, ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { remarkService, type RemarkReviewHistoryEntry } from "@/services/api";

const TEMPLATE_LABELS: Record<string, string> = {
  TPG101: "Toddler's Playgroup",
  ACT102: "Academic Tutorial",
  EXP106: "Examination Preparedness",
};

const PAGE_SIZE = 20;

function personName(person?: { firstName?: string; lastName?: string } | null) {
  if (!person) return "—";
  return [person.firstName, person.lastName].filter(Boolean).join(" ");
}

function reviewerLabel(entry: RemarkReviewHistoryEntry) {
  if (entry.adminDeleted) return "an admin account that no longer exists";
  return personName(entry.admin);
}

type DecisionFilter = "all" | "approve" | "reject";

// PDF: "Review History" — the approve/reject decisions that vanish from the Pending
// queue the moment they're decided. Reads the same AuditLog trail every reviewRemark()
// call already writes (admin identity, decision, reason, timestamp) rather than the
// Remark document's own reviewedBy/reviewedAt fields, which get overwritten by a later
// decision on the same remark or can disappear if the tutor deletes a rejected draft —
// see remarkController.js's listReviewHistory for why.
export function RemarksReviewHistory() {
  const [entries, setEntries] = useState<RemarkReviewHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = async (targetPage: number, filter: DecisionFilter) => {
    setLoading(true);
    try {
      const res = await remarkService.getReviewHistory({
        decision: filter === "all" ? undefined : filter,
        page: targetPage,
        limit: PAGE_SIZE,
      });
      if (res.data?.success) {
        setEntries(res.data.history || []);
        setTotal(res.data.total || 0);
        setTotalPages(res.data.totalPages || 1);
      } else {
        setEntries([]);
        setTotal(0);
        setTotalPages(1);
      }
    } catch {
      setEntries([]);
      setTotal(0);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(page, decisionFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, decisionFilter]);

  const changeFilter = (filter: DecisionFilter) => {
    setDecisionFilter(filter);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h4 className="font-semibold text-foreground">Review History</h4>
          <p className="text-xs text-muted-foreground">Past decisions on remarks that included an attachment.</p>
        </div>
        <div className="flex items-center gap-1">
          {([
            ["all", "All"],
            ["approve", "Approved"],
            ["reject", "Rejected"],
          ] as const).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={decisionFilter === value ? "default" : "outline"}
              className={decisionFilter === value ? "btn-glow" : ""}
              onClick={() => changeFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No review decisions yet.</p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const isRejected = entry.decision === "reject";
            const isExpanded = expandedId === entry._id;
            return (
              <div key={entry._id} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {entry.remarkDeleted ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <AlertTriangle className="h-3.5 w-3.5" /> Remark no longer exists (deleted after this decision)
                        </span>
                      ) : (
                        <>
                          {personName(entry.student)} <span className="text-muted-foreground font-normal">· {personName(entry.tutor)}</span>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {entry.programCode ? (TEMPLATE_LABELS[entry.programCode] || entry.programCode) : "—"}
                      {" · "}
                      Reviewed by {reviewerLabel(entry)}
                      {" · "}
                      {new Date(entry.reviewedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                    </p>
                  </div>
                  <span
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] flex-shrink-0 ${
                      isRejected ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"
                    }`}
                  >
                    {isRejected ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                    {isRejected ? "Rejected" : "Approved"}
                  </span>
                </div>

                {isRejected && entry.reason && (
                  isExpanded ? (
                    <p className="mt-2 text-xs text-foreground bg-destructive/5 border border-destructive/20 rounded-md p-2">
                      {entry.reason}
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setExpandedId(entry._id)}
                      className="mt-1 text-xs text-destructive underline underline-offset-2"
                    >
                      Show rejection reason
                    </button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-muted-foreground">Page {page} of {totalPages} · {total} total</p>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
