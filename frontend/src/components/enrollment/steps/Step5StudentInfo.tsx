import { useState } from 'react';
import { Baby } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import { checkProgramEligibility } from '../wizard-types';
import {
  validateFullName,
  validateBirthdate,
  birthdateMin,
  birthdateMax,
  toTitleCase,
  computeAgeYears,
  MIN_ENROLL_AGE,
} from '@/lib/enrollmentValidation';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; }

const NAME_FIELDS = [
  { key: 'studentFirstName', label: 'First Name *', placeholder: 'e.g. Maria', required: true },
  { key: 'studentMiddleName', label: 'Middle Name (optional)', placeholder: 'e.g. Santos', required: false },
  { key: 'studentLastName', label: 'Last Name *', placeholder: 'e.g. Cruz', required: true },
] as const;

export default function Step5StudentInfo({ data, update, onNext, onBack }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const age = data.birthdate ? validateBirthdate(data.birthdate) : null;

  /**
   * When birthdate changes, immediately drop any selected packages the child is
   * no longer age-eligible for, so stale ineligible packages can't be submitted.
   */
  const handleBirthdateChange = (newBirthdate: string) => {
    const newAge = computeAgeYears(newBirthdate);
    const remaining = data.selectedPackages.filter(
      (pkg) => checkProgramEligibility(pkg.programCode, newAge).eligible,
    );
    update({ birthdate: newBirthdate, selectedPackages: remaining });
    setErrors((p) => ({ ...p, birthdate: '' }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    for (const f of NAME_FIELDS) {
      const label = f.label.replace(' *', '').replace(' (optional)', '');
      const res = validateFullName(data[f.key], label, { minParts: 1, required: f.required });
      if (!res.valid) e[f.key] = res.error!;
    }
    const bd = validateBirthdate(data.birthdate);
    if (!bd.valid) e.birthdate = bd.error!;
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Student Information</h2>
        <p className="text-muted-foreground text-sm mt-1">Tell us about your child. Age is computed automatically from the birthdate.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {NAME_FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={f.key}>{f.label}</Label>
            <Input
              id={f.key}
              placeholder={f.placeholder}
              className={errors[f.key] ? 'border-destructive' : ''}
              value={data[f.key]}
              onChange={(e) => { update({ [f.key]: e.target.value }); setErrors((p) => ({ ...p, [f.key]: '' })); }}
              onBlur={(e) => {
                const cleaned = toTitleCase(e.target.value);
                if (cleaned && cleaned !== e.target.value) update({ [f.key]: cleaned });
                const label = f.label.replace(' *', '').replace(' (optional)', '');
                const res = validateFullName(cleaned || e.target.value, label, { minParts: 1, required: f.required });
                setErrors((p) => ({ ...p, [f.key]: res.valid ? '' : res.error! }));
              }}
            />
            {errors[f.key] && <p className="text-xs text-destructive">{errors[f.key]}</p>}
          </div>
        ))}

        <div className="space-y-1.5">
          <Label htmlFor="birthdate">Birthdate *</Label>
          <Input
            id="birthdate"
            type="date"
            min={birthdateMin()}
            max={birthdateMax()}
            className={errors.birthdate ? 'border-destructive' : ''}
            value={data.birthdate}
            onChange={(e) => handleBirthdateChange(e.target.value)}
          />
          {errors.birthdate && <p className="text-xs text-destructive">{errors.birthdate}</p>}
          {age && age.ageLabel && (
            <div className="flex items-center gap-2 mt-1">
              <Baby className="h-3.5 w-3.5 text-amber-600" />
              <span className="text-sm font-medium text-foreground">Age: {age.ageLabel}</span>
              <Badge
                variant={age.eligible ? 'default' : 'destructive'}
                className={age.eligible ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' : ''}
              >
                {age.eligible ? 'Eligible' : 'Not eligible'}
              </Badge>
            </div>
          )}
          {age && !age.valid && !errors.birthdate && (
            <p className="text-xs text-destructive">{age.error}</p>
          )}
        </div>
      </div>

      <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 rounded-lg text-xs text-amber-800 dark:text-amber-300">
        <strong>Note:</strong> Grade level is not required — program eligibility is determined by your child's age.
        Students must be at least {MIN_ENROLL_AGE} years old to enroll.
      </div>

      <StepNav onBack={onBack} onNext={() => { if (validate()) onNext(); }} />
    </div>
  );
}
