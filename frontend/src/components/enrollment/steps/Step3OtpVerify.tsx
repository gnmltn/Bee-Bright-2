import { useState, useEffect, useRef } from 'react';
import { Mail, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';
import { parentAuthService } from '@/services/api';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']; }

const RESEND_COOLDOWN = 120; // seconds

export default function Step3OtpVerify({ data, update, onNext, onBack, toast }: Props) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCooldown = (seconds = RESEND_COOLDOWN) => {
    setCooldown(seconds);
    timerRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) { clearInterval(timerRef.current!); return 0; }
        return c - 1;
      });
    }, 1000);
  };

  useEffect(() => { startCooldown(); return () => { if (timerRef.current) clearInterval(timerRef.current); }; }, []);

  const handleVerify = async () => {
    if (!code.trim() || code.length !== 6) { setError('Enter the 6-digit code sent to your email.'); return; }
    setLoading(true); setError('');
    try {
      const res = await parentAuthService.verifyOtp(data.parentEmail.trim().toLowerCase(), code.trim());
      const token = res.data.token;
      update({ enrollmentToken: token });
      // Write the enrollment-scoped JWT to sessionStorage so the axios
      // interceptor automatically sends it as Authorization: Bearer <token>
      // when the wizard submits. It will be cleared after submission.
      try { window.sessionStorage.setItem('token', token); } catch { /* ignore */ }
      toast({ title: 'Email verified!', description: 'Your email has been verified. Continue to enrollment.' });
      onNext();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Incorrect code. Please try again.';
      setError(msg);
    } finally { setLoading(false); }
  };

  const handleResend = async () => {
    if (cooldown > 0) return;
    setResendLoading(true); setError('');
    try {
      await parentAuthService.sendOtp(data.parentEmail.trim().toLowerCase());
      toast({ title: 'Code resent', description: 'A new verification code was sent to your email.' });
      startCooldown();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Failed to resend code.';
      setError(msg);
    } finally { setResendLoading(false); }
  };

  const maskedEmail = (() => {
    const em = data.parentEmail || '';
    const [local = '', domain = ''] = em.split('@');
    if (local.length <= 2) return `${local[0] || '*'}*@${domain}`;
    return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
  })();

  return (
    <div className="space-y-6 max-w-md mx-auto">
      <div className="text-center">
        <div className="h-14 w-14 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-3">
          <Mail className="h-7 w-7 text-amber-600" />
        </div>
        <h2 className="text-xl font-bold">Verify Your Email</h2>
        <p className="text-muted-foreground text-sm mt-1">
          We sent a 6-digit code to <strong>{maskedEmail}</strong>. Enter it below to continue.
        </p>
      </div>

      <div className="space-y-3">
        <Input
          type="text" inputMode="numeric" maxLength={6} placeholder="• • • • • •"
          className={`text-center text-2xl tracking-[0.5em] font-bold h-14 ${error ? 'border-destructive' : ''}`}
          value={code}
          onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleVerify(); }}
        />
        {error && <p className="text-xs text-destructive text-center">{error}</p>}
      </div>

      <div className="text-center">
        <Button variant="ghost" size="sm" disabled={cooldown > 0 || resendLoading} onClick={handleResend} className="gap-1 text-sm">
          <RefreshCw className={`h-3.5 w-3.5 ${resendLoading ? 'animate-spin' : ''}`} />
          {cooldown > 0 ? `Resend in ${cooldown}s` : resendLoading ? 'Sending…' : 'Resend Code'}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground text-center">Code expires in 10 minutes.</p>

      <StepNav onBack={onBack} onNext={handleVerify} nextLabel="Verify Code" loading={loading} disableNext={code.length !== 6} />
    </div>
  );
}
