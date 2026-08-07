import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StepNavProps {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  loading?: boolean;
  disableNext?: boolean;
  hideBack?: boolean;
}

export default function StepNav({ onBack, onNext, nextLabel = 'Continue', loading, disableNext, hideBack }: StepNavProps) {
  return (
    <div className="flex items-center justify-between pt-6 mt-6 border-t border-border">
      {!hideBack ? (
        <Button variant="outline" onClick={onBack} disabled={loading} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
      ) : <span />}
      <Button onClick={onNext} disabled={disableNext || loading} className="gap-1 bg-amber-500 hover:bg-amber-600 text-white min-w-[130px]">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>{nextLabel} <ChevronRight className="h-4 w-4" /></>}
      </Button>
    </div>
  );
}
