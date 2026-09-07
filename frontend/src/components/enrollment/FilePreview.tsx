import { useState } from 'react';
import { FileText, Maximize2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

type PreviewSource =
  | { dataUrl: string; fileName: string; fileSize?: number }
  | null
  | undefined;

function isPdf(src: { dataUrl: string; fileName: string }): boolean {
  return /^data:application\/pdf/i.test(src.dataUrl) || /\.pdf$/i.test(src.fileName);
}

/**
 * Inline preview of an uploaded enrollment document (image or PDF), with a
 * "click to view full size" action that opens it in a modal.
 *
 * Reused by Step 1 (Requirements), Step 10 (Proof of Payment) and the
 * Student Dashboard "Add Child" modal — do not fork this.
 */
export default function FilePreview({
  src,
  label,
  className = '',
}: {
  src: PreviewSource;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!src?.dataUrl) return null;

  const pdf = isPdf(src);
  const sizeKb = src.fileSize ? `${(src.fileSize / 1024).toFixed(0)} KB` : '';

  return (
    <>
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl p-0">
          <DialogTitle className="flex items-center justify-between border-b px-4 py-2 text-sm">
            <span className="truncate pr-2">{label || src.fileName}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              aria-label="Close preview"
            >
              <X className="h-4 w-4" />
            </button>
          </DialogTitle>
          <div className="max-h-[80vh] overflow-auto bg-muted/30 p-2">
            {pdf ? (
              <object data={src.dataUrl} type="application/pdf" className="h-[75vh] w-full rounded">
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Preview not supported here.{' '}
                  <a href={src.dataUrl} download={src.fileName} className="text-amber-600 underline">
                    Download {src.fileName}
                  </a>
                </div>
              </object>
            ) : (
              <img src={src.dataUrl} alt={label || src.fileName} className="mx-auto max-h-[75vh] w-auto" />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
