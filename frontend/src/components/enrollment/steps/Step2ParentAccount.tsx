import { useEffect, useState } from 'react';
import { User, Mail, Phone, Lock, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import { parentAuthService } from '@/services/api';
import { validateFullName, validateMobileNumber, normalizeMobile, toTitleCase } from '@/lib/enrollmentValidation';
import { getEmailError, getEmailCharacterError } from '@/utils/emailRules';

interface Props {
  data: WizardData;
  update: (p: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
  /**
   * True when the caller already has its own real session (e.g. an admin running
   * the walk-in Add Student wizard) — skips clearing sessionStorage's shared
   * 'token' key, which would otherwise silently log that caller out. Defaults to
   * false (the original anonymous-parent-signup behavior below).
   */
  keepSessionToken?: boolean;
}

const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

export default function Step2ParentAccount({ data, update, onNext, onBack, toast, keepSessionToken }: Props) {
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  // confirmPassword is local — not stored in WizardData, just for validation
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Final "is everything correct?" review before the verification code is sent.
  const [showConfirm, setShowConfirm] = useState(false);

  type NamePart = 'parentFirstName' | 'parentMiddleName' | 'parentLastName';
  const NAME_LABELS: Record<NamePart, string> = { parentFirstName: 'First name', parentMiddleName: 'Middle name', parentLastName: 'Last name' };
  const joinName = (first: string, middle: string, last: string) => [first, middle, last].map((p) => p.trim()).filter(Boolean).join(' ');

  // A draft saved before the name was split only has the combined parentName — split it once.
  useEffect(() => {
    if (data.parentName && !data.parentFirstName && !data.parentLastName) {
      const parts = data.parentName.trim().split(/\s+/).filter(Boolean);
      update({
        parentFirstName: parts[0] || '',
        parentMiddleName: parts.length > 2 ? parts.slice(1, -1).join(' ') : '',
        parentLastName: parts.length > 1 ? parts[parts.length - 1] : '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setNamePart = (part: NamePart, value: string) => {
    const next = { parentFirstName: data.parentFirstName, parentMiddleName: data.parentMiddleName, parentLastName: data.parentLastName, [part]: value };
    update({ [part]: value, parentName: joinName(next.parentFirstName, next.parentMiddleName, next.parentLastName) });
    setErrors((p) => ({ ...p, [part]: '' }));
  };

  const validateNamePart = (part: NamePart, value: string) => {
    const r = validateFullName(value, NAME_LABELS[part], { minParts: 1, required: part !== 'parentMiddleName' });
    return r.valid ? '' : r.error!;
  };

  const validate = () => {
    const e: Record<string, string> = {};

    (['parentFirstName', 'parentMiddleName', 'parentLastName'] as NamePart[]).forEach((part) => {
      const problem = validateNamePart(part, data[part]);
      if (problem) e[part] = problem;
    });

    const emailProblem = getEmailError(data.parentEmail);
    if (emailProblem) e.parentEmail = emailProblem;

    const mobileRes = validateMobileNumber(data.parentMobile, 'Mobile number');
    if (!mobileRes.valid) e.parentMobile = mobileRes.error!;

    if (!PASSWORD_RE.test(data.parentPassword))
      e.parentPassword = 'Password needs 8+ chars, uppercase, lowercase, number, and special character (@$!%*?&).';

    if (!confirmPassword.trim())
      e.confirmPassword = 'Please confirm your password.';
    else if (confirmPassword !== data.parentPassword)
      e.confirmPassword = 'Passwords do not match. Please re-enter.';

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // "Create Account & Send Code" → validate, then show the review modal.
  const handleSubmit = () => {
    if (!validate()) return;
    setShowConfirm(true);
  };

  // Confirmed in the modal → actually register the draft and send the code.
  const handleConfirmedRegister = async () => {
    setShowConfirm(false);
    setLoading(true);
    try {
      const res = await parentAuthService.register({
        firstName: toTitleCase(data.parentFirstName),
        middleName: data.parentMiddleName.trim() ? toTitleCase(data.parentMiddleName) : '',
        lastName: toTitleCase(data.parentLastName),
        email: data.parentEmail.trim().toLowerCase(),
        mobile: normalizeMobile(data.parentMobile),
        password: data.parentPassword,
        // Lets the parent go Back and fix a typo without their own earlier draft
        // blocking them — the same draft record is updated in place.
        draftId: data.parentId,
      });
      // Any previously-verified email/token is stale once we (re)register.
      update({ parentId: res.data.parentId, enrollmentToken: null });
      if (!keepSessionToken) {
        try { window.sessionStorage.removeItem('token'); } catch { /* ignore */ }
      }
      toast({
        title: 'Verification code sent',
        description: `A 6-digit code was sent to ${res.data.verificationSentTo}`,
      });
      onNext();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        'Registration failed. Please try again.';
      toast({ title: 'Registration failed', description: msg, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  // Password match indicator
  const passwordsMatch =
    confirmPassword.length > 0 && confirmPassword === data.parentPassword;
  const passwordsMismatch =
    confirmPassword.length > 0 && confirmPassword !== data.parentPassword;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Parent / Guardian Account</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Create your account to start the enrollment wizard. Your child's classes will be linked to this account.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">

        {/* First / Middle / Last name */}
        <div className="md:col-span-2 grid gap-4 md:grid-cols-3">
          {([
            { part: 'parentFirstName', id: 'parentFirstName', label: 'First Name *', placeholder: 'Maria', icon: true },
            { part: 'parentMiddleName', id: 'parentMiddleName', label: 'Middle Name', placeholder: 'Reyes (optional)', icon: false },
            { part: 'parentLastName', id: 'parentLastName', label: 'Last Name *', placeholder: 'Santos', icon: false },
          ] as { part: NamePart; id: string; label: string; placeholder: string; icon: boolean }[]).map(({ part, id, label, placeholder, icon }) => (
            <div key={part} className="space-y-1.5">
              <Label htmlFor={id}>{label}</Label>
              <div className="relative">
                {icon && <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />}
                <Input
                  id={id} type="text" placeholder={placeholder} autoComplete={part === 'parentFirstName' ? 'given-name' : part === 'parentLastName' ? 'family-name' : 'additional-name'}
                  className={`${icon ? 'pl-10' : ''} ${errors[part] ? 'border-destructive' : ''}`}
                  value={data[part]}
                  onChange={(e) => setNamePart(part, e.target.value)}
                  onBlur={(e) => {
                    const cleaned = toTitleCase(e.target.value);
                    if (cleaned && cleaned !== e.target.value) setNamePart(part, cleaned);
                    setErrors((p) => ({ ...p, [part]: validateNamePart(part, cleaned || e.target.value) }));
                  }}
                />
              </div>
              {errors[part] && <p className="text-xs text-destructive">{errors[part]}</p>}
            </div>
          ))}
        </div>

        {/* Email */}
        <div className="space-y-1.5">
          <Label htmlFor="parentEmail">Email Address *</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="parentEmail" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="maria@example.com"
              className={`pl-10 ${errors.parentEmail ? 'border-destructive' : ''}`}
              value={data.parentEmail}
              onChange={(e) => { update({ parentEmail: e.target.value }); setErrors((p) => ({ ...p, parentEmail: getEmailCharacterError(e.target.value) || '' })); }}
            />
          </div>
          {errors.parentEmail && <p className="text-xs text-destructive">{errors.parentEmail}</p>}
        </div>

        {/* Mobile */}
        <div className="space-y-1.5">
          <Label htmlFor="parentMobile">Mobile Number *</Label>
          <div className="relative">
            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="parentMobile" type="tel" inputMode="numeric" placeholder="09XXXXXXXXX"
              className={`pl-10 ${errors.parentMobile ? 'border-destructive' : ''}`}
              value={data.parentMobile}
              onChange={(e) => {
                update({ parentMobile: e.target.value.replace(/[^\d\s+()-]/g, '') });
                setErrors((p) => ({ ...p, parentMobile: '' }));
              }}
              onBlur={async (e) => {
                const r = validateMobileNumber(e.target.value, 'Mobile number');
                if (!r.valid) { setErrors((p) => ({ ...p, parentMobile: r.error! })); return; }
                try {
                  const chk = await parentAuthService.checkMobile(normalizeMobile(e.target.value));
                  if (!chk.data.available) {
                    setErrors((p) => ({ ...p, parentMobile: 'Mobile number is already registered to another account.' }));
                  }
                } catch { /* non-blocking — the submit still enforces it */ }
              }}
            />
          </div>
          {errors.parentMobile && <p className="text-xs text-destructive">{errors.parentMobile}</p>}
        </div>

        {/* Password */}
        <div className="space-y-1.5">
          <Label htmlFor="parentPassword">Password *</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="parentPassword"
              type={showPw ? 'text' : 'password'}
              placeholder="Min 8 characters"
              className={`pl-10 pr-10 ${errors.parentPassword ? 'border-destructive' : ''}`}
              value={data.parentPassword}
              onChange={(e) => {
                update({ parentPassword: e.target.value });
                setErrors((p) => ({ ...p, parentPassword: '' }));
                // Clear confirm error if user re-types password
                if (confirmPassword) setErrors((p) => ({ ...p, confirmPassword: '' }));
              }}
            />
            <button
              type="button"
              onClick={() => setShowPw((p) => !p)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Toggle password visibility"
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {errors.parentPassword && <p className="text-xs text-destructive">{errors.parentPassword}</p>}
        </div>

        {/* Confirm Password — sits beside Password in the same row, same width, via normal
            grid auto-flow (no explicit column), matching how Email/Mobile and the three name
            fields are already paired. An earlier fix (Redundant_Switchers...pdf item F) forced
            `md:col-start-1` to fix this field's WIDTH, but that also forced it onto a new row
            of its own — this drops that override so it just falls into column 2 next to
            Password, the way any other unconstrained grid item would. */}
        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword">Confirm Password *</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="confirmPassword"
              type={showConfirmPw ? 'text' : 'password'}
              placeholder="Re-enter your password"
              className={`pl-10 pr-10 ${
                errors.confirmPassword
                  ? 'border-destructive'
                  : passwordsMatch
                  ? 'border-emerald-500'
                  : ''
              }`}
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setErrors((p) => ({ ...p, confirmPassword: '' }));
              }}
            />
            {/* Toggle visibility */}
            <button
              type="button"
              onClick={() => setShowConfirmPw((p) => !p)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Toggle confirm password visibility"
            >
              {showConfirmPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {/* Inline match feedback */}
          {passwordsMatch && (
            <p className="text-xs text-emerald-600 flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Passwords match.
            </p>
          )}
          {passwordsMismatch && !errors.confirmPassword && (
            <p className="text-xs text-destructive">Passwords do not match.</p>
          )}
          {errors.confirmPassword && (
            <p className="text-xs text-destructive">{errors.confirmPassword}</p>
          )}
        </div>

      </div>

      <p className="text-xs text-muted-foreground">
        Password must be at least 8 characters with uppercase, lowercase, number, and special character (@$!%*?&).
      </p>

      <StepNav onBack={onBack} onNext={handleSubmit} nextLabel="Create Account & Send Code" loading={loading} />

      {/* Final review before the verification code is sent */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Please review your information</DialogTitle>
            <DialogDescription>
              We'll send a 6-digit verification code to this email. Make sure everything is correct
              so you don't have to start over.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/30 divide-y divide-border text-sm">
            <div className="flex justify-between gap-4 px-3 py-2">
              <span className="text-muted-foreground">First Name</span>
              <span className="font-medium text-right break-words">{toTitleCase(data.parentFirstName) || '—'}</span>
            </div>
            <div className="flex justify-between gap-4 px-3 py-2">
              <span className="text-muted-foreground">Middle Name</span>
              <span className="font-medium text-right break-words">{toTitleCase(data.parentMiddleName) || '—'}</span>
            </div>
            <div className="flex justify-between gap-4 px-3 py-2">
              <span className="text-muted-foreground">Last Name</span>
              <span className="font-medium text-right break-words">{toTitleCase(data.parentLastName) || '—'}</span>
            </div>
            <div className="flex justify-between gap-4 px-3 py-2">
              <span className="text-muted-foreground">Email Address</span>
              <span className="font-medium text-right break-all">{data.parentEmail.trim().toLowerCase() || '—'}</span>
            </div>
            <div className="flex justify-between gap-4 px-3 py-2">
              <span className="text-muted-foreground">Mobile Number</span>
              <span className="font-medium text-right">{normalizeMobile(data.parentMobile) || '—'}</span>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setShowConfirm(false)} disabled={loading}>
              Go Back &amp; Edit
            </Button>
            <Button
              onClick={handleConfirmedRegister}
              disabled={loading}
              className="bg-amber-500 hover:bg-amber-600 text-white"
            >
              Confirm &amp; Send Code
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
