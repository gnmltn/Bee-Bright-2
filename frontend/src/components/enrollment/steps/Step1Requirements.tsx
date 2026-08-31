import { useRef } from 'react';
import { FileText, Clock, CreditCard, CheckCircle2, Upload, X, FileImage, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import StepNav from '../StepNav';
import type { WizardData, UploadedDoc } from '../wizard-types';
import { MAX_DOC_BYTES, ALLOWED_DOC_TYPES } from '../wizard-types';
import { useToast } from '@/hooks/use-toast';

interface Props {
  data: WizardData;
  update: (p: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
}

const timeline = [
  { label: 'Complete Enrollment Form',         time: 'Today' },
  { label: 'Submit Payment Proof',             time: 'After submitting' },
  { label: 'Admin Reviews & Verifies Payment', time: '1–2 business days' },
  { label: 'Enrollment Approved',              time: '2–3 business days' },
  { label: 'Schedule Assigned by Admin',       time: 'After approval' },
];

/** One document upload widget */
function DocUpload({
  label,
  desc,
  value,
  onChange,
  onRemove,
  accept = 'image/jpeg,image/jpg,image/png,application/pdf',
}: {
  label: string;
  desc: string;
  value: UploadedDoc | null;
  onChange: (doc: UploadedDoc) => void;
  onRemove: () => void;
  accept?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFile = (file: File) => {
    if (file.size > MAX_DOC_BYTES) {
      toast({ title: 'File too large', description: 'Maximum 10 MB per document.', variant: 'destructive' });
      return;
    }
    if (!ALLOWED_DOC_TYPES.includes(file.type)) {
      toast({ title: 'Invalid file type', description: 'Please upload a JPG, PNG, or PDF.', variant: 'destructive' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      onChange({ dataUrl: reader.result as string, fileName: file.name, fileSize: file.size });
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // reset so same file can be re-selected after removal
    e.target.value = '';
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">{label} <span className="text-destructive">*</span></p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
        {value && (
          <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Uploaded
          </span>
        )}
      </div>

      {value ? (
        /* Uploaded state */
        <div className="flex items-center gap-3 p-3 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-300 rounded-xl">
          <FileImage className="h-8 w-8 text-emerald-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300 truncate">{value.fileName}</p>
            <p className="text-xs text-emerald-600">{(value.fileSize / 1024).toFixed(1)} KB</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10 flex-shrink-0"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        /* Upload dropzone */
        <div
          role="button"
          tabIndex={0}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => ref.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && ref.current?.click()}
          className="flex items-center gap-3 p-3 border-2 border-dashed border-amber-300 rounded-xl cursor-pointer hover:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/10 transition-colors"
          aria-label={`Upload ${label}`}
        >
          <div className="h-9 w-9 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
            <Upload className="h-4 w-4 text-amber-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Click or drag to upload</p>
            <p className="text-xs text-muted-foreground">JPG, PNG or PDF — max 10 MB</p>
          </div>
        </div>
      )}

      <input
        ref={ref}
        type="file"
        className="hidden"
        accept={accept}
        onChange={handleChange}
        aria-hidden="true"
      />
    </div>
  );
}

export default function Step1Requirements({ data, update, onNext }: Props) {
  const { toast } = useToast();
  const isAddChildMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mode') === 'add-child';

  const allDocsUploaded =
    !!data.docBirthCertificate && !!data.docStudentPhoto && !!data.docGuardianId;

  const handleNext = () => {
    if (!allDocsUploaded) {
      toast({
        title: 'Documents required',
        description: 'Please upload all three required documents before continuing.',
        variant: 'destructive',
      });
      return;
    }
    onNext();
  };

  return (
    <div className="space-y-7">

      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-foreground">Enrollment Requirements</h2>
        <p className="text-muted-foreground text-sm mt-1">
          {isAddChildMode
            ? 'Upload the three required documents below before continuing with this child\'s enrollment.'
            : 'Upload the three required documents below before creating your account. You can take a clear photo of physical documents.'}
        </p>
      </div>

      {/* ── Document Uploads ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <FileText className="h-4 w-4 text-amber-600" />
          <span className="font-semibold text-foreground text-sm">Required Documents</span>
          <span className="text-xs text-muted-foreground ml-auto">
            {[data.docBirthCertificate, data.docStudentPhoto, data.docGuardianId].filter(Boolean).length}/3 uploaded
          </span>
        </div>

        <DocUpload
          label="Student Birth Certificate"
          desc="Original or photocopy — used for age verification."
          value={data.docBirthCertificate}
          onChange={(doc) => update({ docBirthCertificate: doc })}
          onRemove={() => update({ docBirthCertificate: null })}
        />

        <DocUpload
          label="Recent 2×2 Photo of Student"
          desc="Clear, recent photo of the student (passport or ID style)."
          value={data.docStudentPhoto}
          onChange={(doc) => update({ docStudentPhoto: doc })}
          onRemove={() => update({ docStudentPhoto: null })}
          accept="image/jpeg,image/jpg,image/png"
        />

        <DocUpload
          label="Guardian Valid ID"
          desc="Any government-issued ID of the parent or guardian."
          value={data.docGuardianId}
          onChange={(doc) => update({ docGuardianId: doc })}
          onRemove={() => update({ docGuardianId: null })}
        />
      </div>

      {/* All-uploaded confirmation badge */}
      {allDocsUploaded && (
        <div className="flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-300 rounded-xl">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0" />
          <p className="text-sm text-emerald-800 dark:text-emerald-300 font-medium">
            All documents uploaded — you're ready to continue!
          </p>
        </div>
      )}

      {/* ── Payment note ── */}
      <div className="flex gap-3 p-4 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl">
        <CreditCard className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-foreground text-sm">Payment</p>
          <p className="text-muted-foreground text-xs mt-0.5">
            Full payment or 50% down payment accepted via GCash, SeaBank, or BDO.
            Payment proof is uploaded later in the wizard.
          </p>
        </div>
      </div>

      {/* ── Expected Timeline ── */}
      <div>
        <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2">
          <Clock className="h-4 w-4 text-amber-500" /> Expected Timeline
        </h3>
        <ol className="space-y-2">
          {timeline.map((t, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className="flex-shrink-0 h-6 w-6 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 flex items-center justify-center text-xs font-bold">
                {i + 1}
              </span>
              <div>
                <span className="font-medium text-foreground">{t.label}</span>
                <span className="text-muted-foreground ml-2 text-xs">— {t.time}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* ── Info banner ── */}
      <div className="p-4 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 rounded-xl flex gap-3">
        <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-emerald-800 dark:text-emerald-300">
          Enrollment is open every day with no cut-off. Programs run on a{' '}
          <strong>monthly renewal basis</strong>. Eligibility is determined by your
          child's age — no grade level required.
        </p>
      </div>

      {!allDocsUploaded && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/10 border border-amber-200 rounded-xl">
          <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700">
            Upload all 3 documents above to proceed. These are kept confidential and used for enrollment verification only.
          </p>
        </div>
      )}

      <StepNav hideBack onNext={handleNext} nextLabel="Create Account" />
    </div>
  );
}
