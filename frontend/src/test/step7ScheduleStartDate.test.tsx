import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import Step7Schedule from "@/components/enrollment/steps/Step7Schedule";
import { INITIAL_WIZARD_DATA } from "@/components/enrollment/wizard-types";
import type { WizardData } from "@/components/enrollment/wizard-types";

// "bug (15).pdf" Group AT — there are no classes on Sunday, so the shared "Preferred Start
// Date" field (used as-is by the Main Enrollment wizard, Add Child, Renew/Add Program, and
// Admin Walk-in — all four import this exact component) must reject a Sunday selection,
// the same way it already rejects a past date.
function renderStep(overrides: Partial<WizardData> = {}) {
  const data: WizardData = { ...INITIAL_WIZARD_DATA, ...overrides };
  const update = vi.fn((partial: Partial<WizardData>) => Object.assign(data, partial));
  const onNext = vi.fn();
  const onBack = vi.fn();
  const utils = render(<Step7Schedule data={data} update={update} onNext={onNext} onBack={onBack} />);
  return { ...utils, data, update, onNext, onBack };
}

function toLocalISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nextDow(dow: number): string {
  const d = new Date();
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return toLocalISODate(d);
}
const nextSunday = nextDow(0);
const nextMonday = nextDow(1);
const today = toLocalISODate(new Date());

describe("Step7Schedule: Preferred Start Date rejects Sunday", () => {
  it("sets the native min to today", () => {
    renderStep();
    const input = screen.getByLabelText(/preferred start date/i) as HTMLInputElement;
    expect(input.min).toBe(today);
  });

  it("picking a Sunday shows an inline error and does not clear it as valid", () => {
    const { update } = renderStep();
    const input = screen.getByLabelText(/preferred start date/i);
    fireEvent.change(input, { target: { value: nextSunday } });
    expect(update).toHaveBeenCalledWith({ preferredStartDate: nextSunday });
    expect(screen.getByText(/no classes on sunday/i)).toBeTruthy();
  });

  it("Continue is blocked (onNext never called) when the start date is a Sunday", () => {
    const { onNext } = renderStep({ preferredStartDate: nextSunday, selectedPackages: [] });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onNext).not.toHaveBeenCalled();
    expect(screen.getByText(/no classes on sunday/i)).toBeTruthy();
  });

  it("a non-Sunday date is accepted with no error", () => {
    renderStep();
    const input = screen.getByLabelText(/preferred start date/i);
    fireEvent.change(input, { target: { value: nextMonday } });
    expect(screen.queryByText(/no classes on sunday/i)).toBeNull();
  });

  it("the past-date rule still works alongside the new Sunday rule (regression check)", () => {
    renderStep();
    const input = screen.getByLabelText(/preferred start date/i);
    const yesterday = toLocalISODate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    fireEvent.change(input, { target: { value: yesterday } });
    expect(screen.getByText(/cannot be in the past/i)).toBeTruthy();
  });
});
