import { useState } from 'react';
import { Phone, Mail, User } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import { validateFullName, validateMobileNumber, normalizeMobile, toTitleCase } from '@/lib/enrollmentValidation';
import { parentAuthService } from '@/services/api';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; }

export default function Step8Guardian({ data, update, onNext, onBack }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  // fall back to the account values when the guardian field is still blank
  const guardianName = data.guardianName || data.parentName;
  const guardianPhone = data.guardianPhone || data.parentMobile;
  const guardianEmail = data.guardianEmail || data.parentEmail;

  const setErr = (k: string, v: string) => setErrors((p) => ({ ...p, [k]: v }));

  const validate = () => {
    const e: Record<string, string> = {};

    const gn = validateFullName(guardianName, 'Guardian full name', { minParts: 2 });
    if (!gn.valid) e.guardianName = gn.error!;

    const gp = validateMobileNumber(guardianPhone, 'Guardian mobile number');
    if (!gp.valid) e.guardianPhone = gp.error!;

    if (data.alternateGuardianName.trim()) {
      const an = validateFullName(data.alternateGuardianName, 'Alternate guardian name', { minParts: 2 });
      if (!an.valid) e.alternateGuardianName = an.error!;
    }
    if (data.alternateGuardianPhone.trim()) {
      const ap = validateMobileNumber(data.alternateGuardianPhone, 'Alternate guardian number', { required: false });
      if (!ap.valid) e.alternateGuardianPhone = ap.error!;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Parent / Guardian Information</h2>
        <p className="text-muted-foreground text-sm mt-1">
          This is pre-filled from your account. Update if needed, and optionally add an alternate guardian.
        </p>
      </div>

      <div className="p-4 bg-muted rounded-xl">
        <p className="text-sm font-semibold text-foreground mb-3">Primary Guardian (from your account)</p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="guardianName">Full Name</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="guardianName" className={`pl-10 ${errors.guardianName ? 'border-destructive' : ''}`} value={guardianName}
                onChange={(e) => { update({ guardianName: e.target.value }); setErr('guardianName', ''); }}
                onBlur={(e) => {
                  const cleaned = toTitleCase(e.target.value);
                  if (cleaned && cleaned !== e.target.value) update({ guardianName: cleaned });
                  const r = validateFullName(cleaned || e.target.value, 'Guardian full name', { minParts: 2 });
                  setErr('guardianName', r.valid ? '' : r.error!);
                }}
                placeholder="Guardian full name" />
            </div>
            {errors.guardianName && <p className="text-xs text-destructive">{errors.guardianName}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="guardianPhone">Mobile Number</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="guardianPhone" className={`pl-10 ${errors.guardianPhone ? 'border-destructive' : ''}`} type="tel" inputMode="numeric"
                value={guardianPhone}
                onChange={(e) => { update({ guardianPhone: e.target.value.replace(/[^\d\s+()-]/g, '') }); setErr('guardianPhone', ''); }}
                onBlur={(e) => { const r = validateMobileNumber(e.target.value, 'Guardian mobile number'); setErr('guardianPhone', r.valid ? '' : r.error!); }}
                placeholder="09XXXXXXXXX" />
            </div>
            {errors.guardianPhone && <p className="text-xs text-destructive">{errors.guardianPhone}</p>}
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="guardianEmail">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="guardianEmail" type="email" className="pl-10"
                value={guardianEmail}
                onChange={(e) => update({ guardianEmail: e.target.value })} placeholder="Email address" />
            </div>
          </div>
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-foreground mb-3">Alternate Guardian / Emergency Contact <span className="text-muted-foreground font-normal">(optional)</span></p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="alternateGuardianName">Full Name</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="alternateGuardianName" className={`pl-10 ${errors.alternateGuardianName ? 'border-destructive' : ''}`} value={data.alternateGuardianName}
                onChange={(e) => { update({ alternateGuardianName: e.target.value }); setErr('alternateGuardianName', ''); }}
                onBlur={(e) => {
                  if (!e.target.value.trim()) { setErr('alternateGuardianName', ''); return; }
                  const cleaned = toTitleCase(e.target.value);
                  if (cleaned !== e.target.value) update({ alternateGuardianName: cleaned });
                  const r = validateFullName(cleaned, 'Alternate guardian name', { minParts: 2 });
                  setErr('alternateGuardianName', r.valid ? '' : r.error!);
                }}
                placeholder="Alternate guardian name" />
            </div>
            {errors.alternateGuardianName && <p className="text-xs text-destructive">{errors.alternateGuardianName}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alternateGuardianPhone">Mobile Number</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="alternateGuardianPhone" className={`pl-10 ${errors.alternateGuardianPhone ? 'border-destructive' : ''}`} type="tel" inputMode="numeric"
                value={data.alternateGuardianPhone}
                onChange={(e) => { update({ alternateGuardianPhone: e.target.value.replace(/[^\d\s+()-]/g, '') }); setErr('alternateGuardianPhone', ''); }}
                onBlur={async (e) => {
                  const raw = e.target.value.trim();
                  if (!raw) { setErr('alternateGuardianPhone', ''); return; }
                  const r = validateMobileNumber(raw, 'Alternate guardian number', { required: false });
                  if (!r.valid) { setErr('alternateGuardianPhone', r.error!); return; }
                  if (normalizeMobile(raw) === normalizeMobile(guardianPhone)) {
                    setErr('alternateGuardianPhone', 'The alternate guardian must have a different number from the primary guardian.');
                    return;
                  }
                  try {
                    const chk = await parentAuthService.checkMobile(normalizeMobile(raw));
                    if (!chk.data.available) {
                      setErr('alternateGuardianPhone', 'This number is already registered/used by another account.');
                    }
                  } catch { /* non-blocking */ }
                }}
                placeholder="09XXXXXXXXX" />
            </div>
            {errors.alternateGuardianPhone && <p className="text-xs text-destructive">{errors.alternateGuardianPhone}</p>}
          </div>
        </div>
      </div>

      <StepNav onBack={onBack} onNext={() => { if (validate()) onNext(); }} />
    </div>
  );
}
