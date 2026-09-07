import { describe, it, expect } from 'vitest';
import {
  checkProgramEligibility,
  isEligibleForToddlers,
} from '@/components/enrollment/wizard-types';
import {
  computeAgeYears,
  validateBirthdate,
  birthdateMin,
  birthdateMax,
} from '@/lib/enrollmentValidation';

const TPG_MESSAGE = 'Toddlers Playgroup is for children ages 2 to 4 years old.';

/** YYYY-MM-DD for a birthdate this many years/months/days ago (local time). */
function birthdateAgo(years: number, months = 0, days = 0): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setMonth(d.getMonth() - months);
  d.setDate(d.getDate() - days);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}
const ageAgo = (years: number, months = 0, days = 0) =>
  computeAgeYears(birthdateAgo(years, months, days));

describe('computeAgeYears (calendar-exact)', () => {
  it('reports "exactly N years old today" as >= N', () => {
    for (const years of [2, 3, 4, 5, 18]) {
      expect(ageAgo(years)).toBeGreaterThanOrEqual(years);
      expect(ageAgo(years)).toBeLessThan(years + 0.01);
    }
  });

  it('reports the day before a birthday as under that age', () => {
    expect(ageAgo(2, 0, -1)).toBeLessThan(2);
    expect(ageAgo(5, 0, -1)).toBeLessThan(5);
  });
});

describe('Toddlers Playgroup eligibility (ages 2, 3 and 4)', () => {
  it('unlocks from the exact 2nd birthday onwards', () => {
    expect(isEligibleForToddlers(ageAgo(2))).toBe(true);
    expect(isEligibleForToddlers(ageAgo(2, 0, 1))).toBe(true);
    expect(isEligibleForToddlers(ageAgo(2, 1))).toBe(true);
    expect(isEligibleForToddlers(ageAgo(3))).toBe(true);
    expect(isEligibleForToddlers(ageAgo(3, 6))).toBe(true);
  });

  it('stays locked until the 2nd birthday', () => {
    expect(isEligibleForToddlers(ageAgo(1, 11))).toBe(false);
    expect(isEligibleForToddlers(ageAgo(2, 0, -1))).toBe(false);
  });

  it('covers the whole 4th year and locks at 5', () => {
    expect(isEligibleForToddlers(ageAgo(4))).toBe(true);
    expect(isEligibleForToddlers(ageAgo(4, 1))).toBe(true);
    expect(isEligibleForToddlers(ageAgo(4, 11))).toBe(true);
    expect(isEligibleForToddlers(ageAgo(5))).toBe(false);
    expect(isEligibleForToddlers(ageAgo(6))).toBe(false);
  });

  it('shows one consistent message for too-young and too-old', () => {
    expect(checkProgramEligibility('TPG101', ageAgo(1, 6)).reason).toBe(TPG_MESSAGE);
    expect(checkProgramEligibility('TPG101', ageAgo(6)).reason).toBe(TPG_MESSAGE);
    expect(checkProgramEligibility('TPG101', ageAgo(1, 6)).reason).not.toMatch(/and up/i);
  });
});

describe('Step 5 birthdate gate agrees with the program gate', () => {
  it('accepts a child on their exact 2nd birthday', () => {
    const res = validateBirthdate(birthdateAgo(2));
    expect(res.valid).toBe(true);
    expect(res.eligible).toBe(true);
  });

  it('rejects a child whose 2nd birthday has not arrived', () => {
    const res = validateBirthdate(birthdateAgo(2, 0, -1));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/at least 2 years old/);
  });

  it('allows the whole 18th year and rejects 19', () => {
    expect(validateBirthdate(birthdateAgo(18)).valid).toBe(true);
    expect(validateBirthdate(birthdateAgo(18, 11)).valid).toBe(true);
    expect(validateBirthdate(birthdateAgo(19)).valid).toBe(false);
    expect(validateBirthdate(birthdateAgo(19)).error).toMatch(/up to 18 years old/);
  });

  it('still catches an unrealistic year', () => {
    expect(validateBirthdate('0111-11-01').valid).toBe(false);
  });

  it('the date input bounds let an exactly-2 and an 18-year-old be picked', () => {
    // <input type="date" min max> must not exclude a birthdate the validator accepts.
    expect(birthdateAgo(2) <= birthdateMax()).toBe(true);
    expect(birthdateAgo(18, 11) >= birthdateMin()).toBe(true);
  });
});

describe('Academic Tutorial / Exam Prep', () => {
  it('keeps its own bounds', () => {
    expect(checkProgramEligibility('ACT102', ageAgo(2)).eligible).toBe(true);
    expect(checkProgramEligibility('ACT102', ageAgo(18, 11)).eligible).toBe(true);
    expect(checkProgramEligibility('ACT102', ageAgo(19)).eligible).toBe(false);
    expect(checkProgramEligibility('EXP106', ageAgo(2, 6)).eligible).toBe(false);
    expect(checkProgramEligibility('EXP106', ageAgo(3)).eligible).toBe(true);
  });
});
