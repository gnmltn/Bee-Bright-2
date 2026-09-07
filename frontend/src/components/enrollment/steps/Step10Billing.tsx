import { useState } from 'react';
import { Copy, CheckCheck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import { computeTotalFee } from '../wizard-types';
import DocUploadField from '../DocUploadField';

// Real logo assets from src/assets (seabank_logo.png, bdo_logo.jpg)
// GCash has no image file in assets — uses brand-colour SVG instead
import seabankLogo from '@/assets/seabank_logo.png';
import bdoLogo from '@/assets/bdo_logo.jpg';

interface Props {
  data: WizardData;
  update: (p: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}

const METHODS = [
  {
    id: 'gcash' as const,
    label: 'GCash',
    accentColor: '#0166FF',
    bgSelected: '#EBF3FF',
    accountName: 'Bee Bright Tutorial Center',
    accountNumber: '09307517208',
    branch: null,
    // GCash brand SVG — no image file available in assets
    logo: (
      <svg viewBox="0 0 88 32" className="h-9 w-auto" aria-label="GCash" role="img">
        <rect width="88" height="32" rx="7" fill="#0166FF" />
        <text
          x="44" y="22"
          fontSize="17" fontWeight="bold" fill="white"
          fontFamily="Arial, sans-serif"
          textAnchor="middle"
        >
          GCash
        </text>
      </svg>
    ),
  },
  {
    id: 'seabank' as const,
    label: 'SeaBank',
    accentColor: '#2D4DA0',
    bgSelected: '#EEF2FF',
    accountName: 'Bee Bright Tutorial Center',
    accountNumber: '5678-9012-3456',
    branch: 'Main Branch',
    logo: (
      <img
        src={seabankLogo}
        alt="SeaBank"
        className="h-9 w-auto object-contain"
        draggable={false}
      />
    ),
  },
  {
    id: 'bdo' as const,
    label: 'BDO',
    accentColor: '#003087',
    bgSelected: '#EEF1F9',
    accountName: 'Bee Bright Tutorial Center',
    accountNumber: '0098-7654-3210',
    branch: 'Main Branch',
    logo: (
      <img
        src={bdoLogo}
        alt="BDO"
        className="h-9 w-auto object-contain"
        draggable={false}
      />
    ),
  },
] as const;

export default function Step10Billing({ data, update, onNext, onBack, toast }: Props) {
  const [copying, setCopying] = useState<string | null>(null);

  const totalFull = data.selectedPackages.reduce((s, p) => s + p.price, 0);
  const amountDue = computeTotalFee(data.selectedPackages); // always 50% down
  const remaining = totalFull - amountDue;

  const selectedMethod = METHODS.find((m) => m.id === data.paymentMethod) ?? METHODS[0];

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopying(key);
      setTimeout(() => setCopying(null), 2000);
    } catch {
      toast({ title: 'Copy failed', description: 'Please copy manually.', variant: 'destructive' });
    }
  };

  const instructionRows = [
    { label: 'Account Name',   value: selectedMethod.accountName },
    { label: 'Account Number', value: selectedMethod.accountNumber },
    ...(selectedMethod.branch ? [{ label: 'Branch', value: selectedMethod.branch }] : []),
    { label: 'Amount',         value: `₱${amountDue.toLocaleString()}` },
  ];

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h2 className="text-xl font-bold">Billing & Payment</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Review your amount, choose a payment method, and upload your proof of payment.
        </p>
      </div>

      {/* ── Amount summary ── */}
      <div className="p-4 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 rounded-xl space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Total Package Fee</span>
          <span className="font-medium">₱{totalFull.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            Remaining balance <span className="text-xs">(due after mid-session)</span>
          </span>
          <span className="font-medium">₱{remaining.toLocaleString()}</span>
        </div>
        <div className="flex justify-between font-bold border-t border-amber-300 pt-2">
          <span>Amount Due Now (50% Down Payment)</span>
          <span className="text-amber-700 text-lg">₱{amountDue.toLocaleString()}</span>
        </div>
      </div>

      {/* ── Payment method selection ── */}
      <div>
        <Label className="mb-3 block font-semibold">Select Payment Method</Label>
        <div className="grid grid-cols-3 gap-3">
          {METHODS.map((m) => {
            const isSelected = data.paymentMethod === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => update({ paymentMethod: m.id })}
                aria-pressed={isSelected}
                className={`relative p-3 rounded-xl border-2 flex flex-col items-center gap-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isSelected
                    ? 'border-amber-500 shadow-sm'
                    : 'border-border hover:border-amber-300'
                }`}
                style={{ background: isSelected ? m.bgSelected : undefined }}
              >
                <div className="h-10 flex items-center justify-center">
                  {m.logo}
                </div>
                <span className="text-xs font-semibold text-foreground">{m.label}</span>
                {isSelected && (
                  <span className="absolute top-1.5 right-1.5 h-4 w-4 rounded-full bg-amber-500 flex items-center justify-center">
                    <svg viewBox="0 0 10 8" className="h-2.5 w-2.5" fill="none">
                      <path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Payment instructions ── */}
      <div
        className="p-4 border-2 border-dashed rounded-xl space-y-3"
        style={{ borderColor: selectedMethod.accentColor }}
      >
        <p className="font-semibold text-sm" style={{ color: selectedMethod.accentColor }}>
          {selectedMethod.label} Payment Instructions
        </p>
        <div className="space-y-2.5 text-sm">
          {instructionRows.map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground shrink-0">{label}:</span>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-medium truncate">{value}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 flex-shrink-0"
                  onClick={() => copyToClipboard(value, label)}
                  aria-label={`Copy ${label}`}
                >
                  {copying === label
                    ? <CheckCheck className="h-3.5 w-3.5 text-emerald-500" />
                    : <Copy className="h-3.5 w-3.5" />
                  }
                </Button>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Send the <strong>exact amount</strong> shown above. Keep your transaction receipt — you will upload it below.
        </p>
      </div>

      {/* ── Proof of payment upload ── */}
      <div className="space-y-3">
        <DocUploadField
          label="Upload Proof of Payment"
          desc="Screenshot of your GCash / bank transfer receipt, or a PDF."
          value={data.proofDataUrl ? { dataUrl: data.proofDataUrl, fileName: data.proofFileName || 'proof-of-payment', fileSize: 0 } : null}
          onChange={(doc) => update({ proofDataUrl: doc.dataUrl, proofFileName: doc.fileName })}
          onRemove={() => update({ proofDataUrl: null, proofFileName: null })}
        />

        <div className="space-y-1.5">
          <Label htmlFor="payerReference">
            Reference / Transaction Number{' '}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            id="payerReference"
            placeholder="e.g. GCash ref no. or bank transaction ID"
            value={data.payerReference}
            onChange={(e) => update({ payerReference: e.target.value })}
          />
        </div>
      </div>

      <StepNav
        onBack={onBack}
        onNext={() => {
          if (!data.proofDataUrl) {
            toast({
              title: 'Payment proof required',
              description: 'Please upload your proof of payment to continue.',
              variant: 'destructive',
            });
            return;
          }
          onNext();
        }}
      />
    </div>
  );
}
