import { useState } from 'react';
import { Baby } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import { computeAgeYears, formatAge, checkProgramEligibility } from '../wizard-types';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; }

export default function Step5StudentInfo({ data, update, onNext, onBack }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const ageYears = data.birthdate ? computeAgeYears(data.birthdate) : null;
  const ageLabel = data.birthdate ? formatAge(data.birthdate) : null;

  const isMinAge = ageYears !== null && ageYears >= 1.5;

  /**
   * When birthdate changes:
   * 1. Update the birthdate field.
   * 2. Immediately remove any previously selected packages whose program is
   *    no longer age-eligible under the new birthdate.
   *    This prevents stale ineligible packages from being silently submitted.
   */
  const handleBirthdateChange = (newBirthdate: string) => {
    const newAgeYears = newBirthdate ? computeAgeYears(newBirthdate) : 0;

    // Keep only packages the child is still eligible for
    const remainingPackages = data.selectedPackages.filter((pkg) => {
      const { eligible } = checkProgramEligibility(pkg.programCode, newAgeYears);
      return eligible;
    });

    update({
      birthdate: newBirthdate,
      // Drop ineligible packages so the user must re-select valid ones
      selectedPackages: remainingPackages,
    });

    setErrors((prev) => ({ ...prev, birthdate: '' }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!data.studentFirstName.trim()) e.studentFirstName = 'First name is required.';
    if (!data.studentLastName.trim()) e.studentLastName = 'Last name is required.';
    if (!data.birthdate) e.birthdate = 'Birthdate is required.';
    else {
      const birth = new Date(data.birthdate);
      if (birth > new Date()) e.birthdate = 'Birthdate cannot be in the future.';
      else if (ageYears !== null && ageYears < 1.5) e.birthdate = 'Student must be at least 1 year and 6 months old to enroll.';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // Max date for birthdate: today
  const today = new Date().toISOString().split('T')[0];
  // Min date (max 18 years old – reasonable upper bound)
  const minDate = new Date();
  minDate.setFullYear(minDate.getFullYear() - 18);
  const minDateStr = minDate.toISOString().split('T')[0];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Student Information</h2>
        <p className="text-muted-foreground text-sm mt-1">Tell us about your child. Age is computed automatically from the birthdate.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {(['studentFirstName', 'studentMiddleName', 'studentLastName'] as const).map((field) => {
          const labels = { studentFirstName: 'First Name *', studentMiddleName: 'Middle Name (optional)', studentLastName: 'Last Name *' };
          const placeholders = { studentFirstName: 'e.g. Maria', studentMiddleName: 'e.g. Santos', studentLastName: 'e.g. Cruz' };
          return (
            <div key={field} className="space-y-1.5">
              <Label htmlFor={field}>{labels[field]}</Label>
              <Input id={field} placeholder={placeholders[field]}
                className={errors[field] ? 'border-destructive' : ''}
                value={data[field]}
                onChange={(e) => { update({ [field]: e.target.value }); setErrors((p) => ({ ...p, [field]: '' })); }}
              />
              {errors[field] && <p className="text-xs text-destructive">{errors[field]}</p>}
            </div>
          );
        })}

        <div className="space-y-1.5">
          <Label htmlFor="birthdate">Birthdate *</Label>
          <Input id="birthdate" type="date" min={minDateStr} max={today}
            className={errors.birthdate ? 'border-destructive' : ''}
            value={data.birthdate}
            onChange={(e) => { handleBirthdateChange(e.target.value); }}
          />
          {errors.birthdate && <p className="text-xs text-destructive">{errors.birthdate}</p>}
          {ageLabel && (
            <div className="flex items-center gap-2 mt-1">
              <Baby className="h-3.5 w-3.5 text-amber-600" />
              <span className="text-sm font-medium text-foreground">Age: {ageLabel}</span>
              <Badge variant={isMinAge ? 'default' : 'destructive'} className={isMinAge ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' : ''}>
                {isMinAge ? 'Eligible' : 'Too young (min 1.5 yrs)'}
              </Badge>
            </div>
          )}
        </div>
      </div>

      <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 rounded-lg text-xs text-amber-800 dark:text-amber-300">
        <strong>Note:</strong> Grade level is no longer required. Program eligibility is determined by your child's age in the next step.
      </div>

      <StepNav onBack={onBack} onNext={() => { if (validate()) onNext(); }} />
    </div>
  );
}
