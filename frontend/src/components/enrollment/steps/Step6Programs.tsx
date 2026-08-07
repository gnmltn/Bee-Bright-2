import { useState, useEffect } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Info, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import StepNav from '../StepNav';
import type { WizardData, SelectedPackage } from '../wizard-types';
import {
  computeAgeYears,
  formatAge,
  checkProgramEligibility,
  PROGRAM_LABELS,
  computeTotalFee,
} from '../wizard-types';
import type { PricingPackage } from '@/services/api';
import { pricingService } from '@/services/api';

interface Props {
  data: WizardData;
  update: (p: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}

export default function Step6Programs({ data, update, onNext, onBack, toast }: Props) {
  const [pricing, setPricing] = useState<PricingPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const ageYears = data.birthdate ? computeAgeYears(data.birthdate) : 0;
  const ageLabel = data.birthdate ? formatAge(data.birthdate) : '—';

  // Always 50% down — ensure the wizard data reflects this
  useEffect(() => {
    if (data.paymentOption !== 'down') {
      update({ paymentOption: 'down' });
    }
  }, []);

  useEffect(() => {
    pricingService
      .getAll()
      .then((r) => setPricing(r.data.pricing))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // ── Separate eligible from ineligible — both shown, ineligible are disabled ──
  const eligiblePrograms: Record<string, PricingPackage[]> = {};
  const ineligiblePrograms: Record<string, { pkgs: PricingPackage[]; reason: string }> = {};

  const allCodes = Array.from(new Set(pricing.map((p) => p.programCode)));
  for (const code of allCodes) {
    const { eligible, reason } = checkProgramEligibility(code, ageYears);
    if (eligible) {
      eligiblePrograms[code] = pricing.filter((p) => p.programCode === code);
    } else {
      ineligiblePrograms[code] = {
        pkgs: pricing.filter((p) => p.programCode === code),
        reason: reason || 'Age requirement not met.',
      };
    }
  }

  const hasAnyPrograms = allCodes.length > 0;
  const hasEligiblePrograms = Object.keys(eligiblePrograms).length > 0;

  const isPackageSelected = (pkg: PricingPackage) =>
    data.selectedPackages.some(
      (s) => s.programCode === pkg.programCode && s.packageSlug === pkg.packageSlug
    );

  const togglePackage = (pkg: PricingPackage) => {
    const priceDown = pkg.priceDown ?? Math.ceil(pkg.priceFull * 0.5);

    if (isPackageSelected(pkg)) {
      // Deselect
      update({
        selectedPackages: data.selectedPackages.filter(
          (s) => !(s.programCode === pkg.programCode && s.packageSlug === pkg.packageSlug)
        ),
      });
    } else {
      // Select — one package per program (replace existing selection for same program)
      const filtered = data.selectedPackages.filter((s) => s.programCode !== pkg.programCode);
      const newPkg: SelectedPackage = {
        programCode: pkg.programCode,
        packageSlug: pkg.packageSlug,
        displayName: pkg.displayName,
        price: pkg.priceFull,
        priceDown,
        paymentOption: 'down',
        durationDesc: pkg.durationDesc || '',
      };
      update({ selectedPackages: [...filtered, newPkg] });
      setExpanded(null);
    }
  };

  // Total 50% down amount across all selected packages
  const totalDown = computeTotalFee(data.selectedPackages);
  const totalFull = data.selectedPackages.reduce((s, p) => s + p.price, 0);
  const remaining = totalFull - totalDown;

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h2 className="text-xl font-bold">Program Selection</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Programs shown are matched to your child's age:{' '}
          <Badge variant="outline" className="ml-1 font-semibold">{ageLabel}</Badge>
        </p>
      </div>

      {/* Payment policy banner — no toggle, always 50% down */}
      <div className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-950/20 border border-amber-300 rounded-xl">
        <Info className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold text-amber-900 dark:text-amber-300">50% Down Payment Required</p>
          <p className="text-amber-800 dark:text-amber-400 mt-0.5">
            Payment is split in two: <strong>50% upon enrollment</strong>, and the remaining 50% after
            completing half of your sessions.
          </p>
        </div>
      </div>

      {/* Program list */}
      {loading ? (
        <div className="py-12 text-center text-muted-foreground animate-pulse">
          Loading available programs…
        </div>
      ) : !hasAnyPrograms ? (
        <div className="p-5 bg-amber-50 dark:bg-amber-950/20 border border-amber-300 rounded-xl flex gap-3">
          <Info className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-amber-800 dark:text-amber-300">
              No programs available
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              Please go back and verify the birthdate, or contact Bee Bright for assistance.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">

          {/* ── Eligible programs ── */}
          {Object.entries(eligiblePrograms).map(([code, pkgs]) => {
            const isOpen = expanded === code;
            const selectedForProgram = data.selectedPackages.find((s) => s.programCode === code);

            return (
              <div
                key={code}
                className={`border-2 rounded-xl overflow-hidden transition-all ${
                  selectedForProgram ? 'border-amber-500' : 'border-border'
                }`}
              >
                {/* Program row — click to expand */}
                <button
                  className="w-full flex items-center justify-between p-4 text-left"
                  onClick={() => setExpanded(isOpen ? null : code)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-foreground">{PROGRAM_LABELS[code] || code}</p>
                      {selectedForProgram && (
                        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-xs">
                          ✓ Selected
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {selectedForProgram
                        ? `Package: ${selectedForProgram.displayName}`
                        : 'Tap to choose a package'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    {selectedForProgram && (
                      <div className="text-right">
                        <p className="font-bold text-amber-700 text-sm">
                          ₱{selectedForProgram.priceDown.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground">50% down</p>
                      </div>
                    )}
                    {isOpen
                      ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    }
                  </div>
                </button>

                {/* Package options */}
                {isOpen && (
                  <div className="border-t border-border bg-muted/30 p-3 grid gap-2">
                    {pkgs
                      .sort((a, b) => a.displayOrder - b.displayOrder)
                      .map((pkg) => {
                        const selected = isPackageSelected(pkg);
                        const priceDown = pkg.priceDown ?? Math.ceil(pkg.priceFull * 0.5);

                        return (
                          <button
                            key={pkg.packageSlug}
                            onClick={() => togglePackage(pkg)}
                            className={`flex items-start gap-3 p-3 rounded-lg border-2 text-left transition-all ${
                              selected
                                ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/20'
                                : 'border-border hover:border-amber-300 bg-card'
                            }`}
                          >
                            {/* Selection indicator */}
                            <div
                              className={`mt-0.5 h-5 w-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                                selected
                                  ? 'border-amber-500 bg-amber-500'
                                  : 'border-muted-foreground'
                              }`}
                            >
                              {selected && <CheckCircle2 className="h-3.5 w-3.5 text-white" />}
                            </div>

                            {/* Package info */}
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm text-foreground">{pkg.displayName}</p>
                              {pkg.durationDesc && (
                                <p className="text-xs text-muted-foreground mt-0.5">{pkg.durationDesc}</p>
                              )}
                            </div>

                            {/* Price — 50% down amount only, no strikethrough */}
                            <div className="text-right flex-shrink-0">
                              <p className="font-bold text-amber-600 text-sm">
                                ₱{priceDown.toLocaleString()}
                              </p>
                              <p className="text-xs text-muted-foreground">50% down</p>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}

          {/* ── Ineligible programs — shown disabled with reason ── */}
          {Object.entries(ineligiblePrograms).map(([code, { reason }]) => (
            <div
              key={code}
              className="border-2 border-border rounded-xl overflow-hidden opacity-50 cursor-not-allowed"
              title={reason}
              aria-disabled="true"
            >
              <div className="w-full flex items-center justify-between p-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-foreground">{PROGRAM_LABELS[code] || code}</p>
                    <Badge variant="outline" className="text-xs border-destructive/50 text-destructive">
                      Not eligible
                    </Badge>
                  </div>
                  <p className="text-xs text-destructive mt-0.5">{reason}</p>
                </div>
                <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0 ml-2" />
              </div>
            </div>
          ))}

        </div>
      )}

      {/* Selection summary */}
      {data.selectedPackages.length > 0 && (
        <div className="p-4 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 rounded-xl space-y-1.5">
          <p className="font-semibold text-foreground text-sm mb-2">
            Selected Programs ({data.selectedPackages.length})
          </p>
          {data.selectedPackages.map((p) => (
            <div key={`${p.programCode}-${p.packageSlug}`} className="flex justify-between text-sm">
              <span className="text-muted-foreground truncate mr-2">{p.displayName}</span>
              <span className="font-medium flex-shrink-0">₱{p.priceDown.toLocaleString()}</span>
            </div>
          ))}
          <div className="border-t border-amber-300 mt-2 pt-2 space-y-1">
            <div className="flex justify-between font-bold text-sm">
              <span>Due Now (50% Down Payment)</span>
              <span className="text-amber-700">₱{totalDown.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Remaining balance (due after mid-session)</span>
              <span>₱{remaining.toLocaleString()}</span>
            </div>
          </div>
        </div>
      )}

      <StepNav
        onBack={onBack}
        onNext={() => {
          if (data.selectedPackages.length === 0) {
            toast({
              title: 'No program selected',
              description: 'Please select at least one program package to continue.',
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
