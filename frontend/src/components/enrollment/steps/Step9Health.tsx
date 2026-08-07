import { Heart, AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import StepNav from '../StepNav';
import type { WizardData } from '../wizard-types';

interface Props { data: WizardData; update: (p: Partial<WizardData>) => void; onNext: () => void; onBack: () => void; }

export default function Step9Health({ data, update, onNext, onBack }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Heart className="h-5 w-5 text-rose-500" /> Health & Learning Information
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Help us ensure your child's safety and wellbeing. All fields are optional but recommended.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="allergies">Known Allergies</Label>
          <Input id="allergies" placeholder="e.g. nuts, dairy, dust — or leave blank if none"
            value={data.allergies} onChange={(e) => update({ allergies: e.target.value })} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="medications">Current Medications</Label>
          <Input id="medications" placeholder="e.g. Cetirizine for allergies — or leave blank if none"
            value={data.medications} onChange={(e) => update({ medications: e.target.value })} />
        </div>

        <div className="flex items-center gap-4 p-4 border border-border rounded-xl">
          <div className="flex-1">
            <p className="font-medium text-foreground text-sm">Special Learning Needs</p>
            <p className="text-xs text-muted-foreground mt-0.5">Does your child have a learning disability, developmental concern, or IEP?</p>
          </div>
          <Switch checked={data.specialNeeds} onCheckedChange={(v) => update({ specialNeeds: v, specialNeedsDetails: v ? data.specialNeedsDetails : '' })} />
        </div>

        {data.specialNeeds && (
          <div className="space-y-1.5 pl-2 border-l-2 border-amber-400">
            <Label htmlFor="specialNeedsDetails">Please describe</Label>
            <Textarea id="specialNeedsDetails" rows={3} maxLength={500}
              placeholder="e.g. Autism Spectrum Disorder, speech delay, ADHD…"
              value={data.specialNeedsDetails} onChange={(e) => update({ specialNeedsDetails: e.target.value })} />
            <p className="text-xs text-muted-foreground text-right">{data.specialNeedsDetails.length}/500</p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="emergencyContact">Emergency Contact (Other than Primary Guardian)</Label>
          <Input id="emergencyContact" placeholder="Name and mobile number"
            value={data.emergencyContact} onChange={(e) => update({ emergencyContact: e.target.value })} />
        </div>
      </div>

      <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 rounded-lg flex gap-2 text-xs text-amber-800 dark:text-amber-300">
        <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
        This information is kept confidential and used only to ensure your child's safety during sessions.
      </div>

      <StepNav onBack={onBack} onNext={onNext} />
    </div>
  );
}
