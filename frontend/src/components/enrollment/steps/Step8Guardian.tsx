import { Phone, Mail, User } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; }

export default function Step8Guardian({ data, update, onNext, onBack }: Props) {
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
              <Input id="guardianName" className="pl-10" value={data.guardianName || data.parentName}
                onChange={(e) => update({ guardianName: e.target.value })} placeholder="Guardian full name" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="guardianPhone">Mobile Number</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="guardianPhone" className="pl-10" type="tel"
                value={data.guardianPhone || data.parentMobile}
                onChange={(e) => update({ guardianPhone: e.target.value })} placeholder="09XX XXX XXXX" />
            </div>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="guardianEmail">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="guardianEmail" type="email" className="pl-10"
                value={data.guardianEmail || data.parentEmail}
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
              <Input id="alternateGuardianName" className="pl-10" value={data.alternateGuardianName}
                onChange={(e) => update({ alternateGuardianName: e.target.value })} placeholder="Alternate guardian name" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alternateGuardianPhone">Mobile Number</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="alternateGuardianPhone" className="pl-10" type="tel"
                value={data.alternateGuardianPhone}
                onChange={(e) => update({ alternateGuardianPhone: e.target.value })} placeholder="09XX XXX XXXX" />
            </div>
          </div>
        </div>
      </div>

      <StepNav onBack={onBack} onNext={onNext} />
    </div>
  );
}
