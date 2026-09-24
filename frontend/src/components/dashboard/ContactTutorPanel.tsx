import { Mail, ChevronRight, MessageSquare, Phone } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';

type TutorLike = { _id?: string; firstName?: string; lastName?: string; middleName?: string; email?: string; phone?: string };

interface Props {
  schedules: { tutor?: TutorLike | null; tutors?: TutorLike[] | null }[];
}

function tutorFullName(t: TutorLike) {
  return [t.firstName, t.middleName, t.lastName].filter(Boolean).join(' ') || 'Tutor';
}

/**
 * "Contact Tutor" Quick Action — same Popover-panel template as MyRequestsBell.tsx
 * (NewProgram_Modal_AgeCheck_PaymentBug_ContactTutor.pdf Section D). Lists every
 * tutor currently assigned to the active child's schedules with name/phone/email,
 * rather than the previous silent mailto-or-nothing behavior.
 */
export function ContactTutorPanel({ schedules }: Props) {
  const tutors = new Map<string, TutorLike>();
  for (const s of schedules) {
    const all = [s.tutor, ...(s.tutors || [])].filter((t): t is TutorLike => Boolean(t));
    for (const t of all) {
      const key = t._id || t.email || tutorFullName(t);
      if (key && !tutors.has(key)) tutors.set(key, t);
    }
  }
  const tutorList = [...tutors.values()];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-muted transition-colors text-left"
        >
          <div className="flex items-center gap-3">
            <MessageSquare className="h-4 w-4 text-primary" />
            <span className="text-sm text-muted-foreground">Contact Tutor</span>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Contact Tutor</p>
          <p className="text-xs text-muted-foreground">Reach your child's assigned tutor directly.</p>
        </div>

        <ScrollArea className="max-h-80">
          <div className="p-2">
            {tutorList.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No tutor assigned yet. This will appear once your child's first class is scheduled.
              </p>
            ) : (
              <ul className="space-y-1">
                {tutorList.map((t) => {
                  const key = t._id || t.email || tutorFullName(t);
                  return (
                    <li key={key} className="rounded-lg px-3 py-2.5 hover:bg-muted/60">
                      <p className="text-sm font-medium text-foreground">{tutorFullName(t)}</p>
                      <div className="mt-1 space-y-0.5">
                        {t.phone && (
                          <a href={`tel:${t.phone}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
                            <Phone className="h-3 w-3" /> {t.phone}
                          </a>
                        )}
                        {t.email && (
                          <a href={`mailto:${t.email}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
                            <Mail className="h-3 w-3" /> {t.email}
                          </a>
                        )}
                        {!t.phone && !t.email && (
                          <p className="text-xs text-muted-foreground">No contact details on file.</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
