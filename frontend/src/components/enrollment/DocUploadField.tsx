import { useRef } from 'react';
import { Upload, X, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import FilePreview from './FilePreview';
import {
  ENROLLMENT_FILE_ACCEPT,
  validateEnrollmentFile,
} from '@/lib/enrollmentValidation';

export interface UploadedFile {
  dataUrl: string;
  fileName: string;
  fileSize: number;
}

/**
 * One document upload widget: dropzone → type/size validation → inline preview
 * (image thumbnail or PDF) with click-to-expand. Shared by Step 1 (Requirements),
 * Step 10 (Proof of Payment) and the "Add Child" modal.
 */
export default function DocUploadField({
  label,
  desc,
  value,
  onChange,
  onRemove,
  required = true,
  accept = ENROLLMENT_FILE_ACCEPT,
}: {
  label: string;
  desc?: string;
  value: UploadedFile | null;
  onChange: (doc: UploadedFile) => void;
  onRemove: () => void;
  required?: boolean;
  accept?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFile = (file: File) => {
    const { valid, error } = validateEnrollmentFile(file);
    if (!valid) {
      toast({ title: 'Upload rejected', description: error || 'Invalid file.', variant: 'destructive' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onChange({ dataUrl: reader.result as string, fileName: file.name, fileSize: file.size });
    reader.onerror = () =>
      toast({ title: 'Could not read file', description: 'Please try a different file.', variant: 'destructive' });
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">
            {label} {required && <span className="text-destructive">*</span>}
          </p>
          {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
        </div>
        {value && (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" /> Uploaded
          </span>
        )}
      </div>

      {value ? (
        <div className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3 dark:bg-emerald-950/20">
          <FilePreview src={value} label={label} />
          <div className="flex items-center justify-between">
            <p className="text-xs text-emerald-700 dark:text-emerald-400">
              Check that the uploaded file is correct and readable.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-destructive hover:bg-destructive/10"
              onClick={onRemove}
              aria-label={`Remove ${label}`}
            >
              <X className="h-3.5 w-3.5" /> Replace
            </Button>
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
          onClick={() => ref.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && ref.current?.click()}
          className="flex items-center gap-3 rounded-xl border-2 border-dashed border-amber-300 p-3 transition-colors hover:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/10"
          aria-label={`Upload ${label}`}
        >
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
            <Upload className="h-4 w-4 text-amber-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Click or drag to upload</p>
            <p className="text-xs text-muted-foreground">JPG, JPEG, PNG or PDF — max 5 MB</p>
          </div>
        </div>
      )}

      <input
        ref={ref}
        type="file"
        className="hidden"
        accept={accept}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
        aria-hidden="true"
      />
    </div>
  );
}
