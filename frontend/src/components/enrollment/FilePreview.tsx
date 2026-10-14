import { useEffect, useState } from 'react';
import { AlertTriangle, FileText, Loader2, Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

type PreviewSource =
  | { dataUrl: string; fileName: string; fileSize?: number }
  | null
  | undefined;

function isPdf(src: { dataUrl: string; fileName: string }): boolean {
  // blob: URLs (Remarks' attachment viewer) never encode a MIME type in the URL string
  // itself, so for those this always falls through to the fileName check.
  return /^data:application\/pdf/i.test(src.dataUrl) || /\.pdf$/i.test(src.fileName);
}

/**
 * Inline preview of an uploaded enrollment document (image or PDF), with a
 * "click to view full size" action that opens it in a modal.
 *
 * Reused by Step 1 (Requirements), Step 10 (Proof of Payment), the Student Dashboard
 * "Add Child" modal, and the Remarks attachment viewers — do not fork this.
 *
 * `open`/`onOpenChange` are optional and only for a caller that already has its own
 * "View" button elsewhere (e.g. the Certificate feature's History/Progress cards) and
 * wants to drive this component's modal directly, instead of via its own thumbnail —
 * pass `hideTrigger` too in that case to skip rendering the thumbnail entirely. Every
 * existing caller omits all three and keeps today's uncontrolled, click-the-thumbnail
 * behavior unchanged.
 */
export default function FilePreview({
  src,
  label,
  className = '',
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  src: PreviewSource;
  label?: string;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = controlledOpen !== undefined ? (onOpenChange ?? (() => {})) : setInternalOpen;
  const [pdfEmbedUrl, setPdfEmbedUrl] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const pdf = src?.dataUrl ? isPdf(src) : false;

  // A plain http(s) URL (enrollment documents / payment proofs, served from the backend's
  // own origin/port — a different origin than the frontend dev server) gets silently
  // blocked when embedded directly in <object>: the backend sends
  // `X-Frame-Options: SAMEORIGIN`, which forbids cross-origin framing, so the browser
  // renders this component's own "Preview not supported here" fallback even though the
  // file is completely fine (confirmed: downloading the same URL works). A `data:`/`blob:`
  // URL (already same-origin — this is exactly how the Remarks attachment viewer, which
  // never had this bug, fetches its file: as a blob, then `URL.createObjectURL`) embeds
  // without issue. So: fetch a cross-origin http(s) PDF into a blob first, same as Remarks
  // already does, then embed THAT.
  useEffect(() => {
    if (open) setImgFailed(false);
    if (!open || !pdf || !src?.dataUrl) { setPdfEmbedUrl(null); return; }
    if (/^(?:data|blob):/i.test(src.dataUrl)) { setPdfEmbedUrl(src.dataUrl); return; }
    let cancelled = false;
    let objectUrl: string | null = null;
    setPdfEmbedUrl(null);
    fetch(src.dataUrl, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfEmbedUrl(objectUrl);
      })
      .catch(() => {
        // Fall back to the raw URL — worst case is the pre-existing behavior, never worse.
        if (!cancelled) setPdfEmbedUrl(src.dataUrl);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, pdf, src?.dataUrl]);

  // A caller using the controlled `open`/`hideTrigger` mode may open the dialog before
  // its async src is ready (e.g. still fetching the object URL) — show it with a
  // spinner rather than rendering nothing, instead of returning null like the
  // uncontrolled/thumbnail mode does when there's nothing to show yet.
  if (!src?.dataUrl && !hideTrigger) return null;

  const sizeKb = src?.fileSize ? `${(src.fileSize / 1024).toFixed(0)} KB` : '';

  return (
    <>
      {!hideTrigger && src?.dataUrl && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`group relative block w-full overflow-hidden rounded-lg border border-border bg-muted/40 text-left transition-colors hover:border-amber-400 ${className}`}
          aria-label={`View ${label || src.fileName} full size`}
        >
          {pdf ? (
            <div className="flex items-center gap-3 p-3">
              <div className="flex h-14 w-12 flex-shrink-0 items-center justify-center rounded bg-red-50 text-red-500 dark:bg-red-950/30">
                <FileText className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{src.fileName}</p>
                <p className="text-xs text-muted-foreground">PDF{sizeKb ? ` · ${sizeKb}` : ''} · click to open</p>
              </div>
              <Maximize2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            </div>
          ) : (
            <>
              <img
                src={src.dataUrl}
                alt={label || src.fileName}
                className="max-h-48 w-full object-contain bg-white"
              />
              <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                <Maximize2 className="h-3 w-3" /> View full size
              </span>
              <span className="block truncate px-2 py-1 text-xs text-muted-foreground">
                {src.fileName}{sizeKb ? ` · ${sizeKb}` : ''}
              </span>
            </>
          )}
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl p-0">
          {/* DialogContent already renders its own close "X" (@/components/ui/dialog) —
              this header only needs the title, not a second close button on top of it. */}
          <DialogTitle className="border-b px-4 py-2 pr-10 text-sm">
            <span className="truncate">{label || src?.fileName || 'Preview'}</span>
          </DialogTitle>
          <div className="max-h-[80vh] overflow-auto bg-muted/30 p-2">
            {!src?.dataUrl ? (
              <div className="flex h-[75vh] items-center justify-center text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : pdf ? (
              pdfEmbedUrl ? (
                <object data={pdfEmbedUrl} type="application/pdf" className="h-[75vh] w-full rounded">
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    Preview not supported here.{' '}
                    <a href={src.dataUrl} download={src.fileName} className="text-amber-600 underline">
                      Download {src.fileName}
                    </a>
                  </div>
                </object>
              ) : (
                <div className="flex h-[75vh] items-center justify-center text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              )
            ) : imgFailed ? (
              <div className="flex h-[50vh] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <AlertTriangle className="h-8 w-8 text-destructive" />
                <p>This file failed to load — it may be missing or moved.</p>
                <a href={src.dataUrl} download={src.fileName} className="text-amber-600 underline">
                  Download {src.fileName}
                </a>
              </div>
            ) : (
              <img
                src={src.dataUrl}
                alt={label || src.fileName}
                onError={() => setImgFailed(true)}
                className="mx-auto max-h-[75vh] w-auto"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
