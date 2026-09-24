import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "bb-active-child-id";

/**
 * The parent dashboard's "Viewing child" selection is per-enrollment (each
 * entry in the selector is one enrollment's studentSnapshot). StudentDashboard.tsx
 * and StudentPayments.tsx are separate routed pages, so a plain useState there
 * doesn't survive navigating between them — sessionStorage does, keeping "the
 * child I'm looking at" consistent across the whole dashboard, including which
 * child's invoices/payment history show (Invoice_Display_DownPaymentBug_Receipt_
 * RemarksPolicy.pdf D).
 */
export function useActiveChildId(): [string, (id: string) => void] {
  const [activeChildId, setActiveChildIdState] = useState<string>(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY) || "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setActiveChildIdState(e.newValue || "");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setActiveChildId = useCallback((id: string) => {
    setActiveChildIdState(id);
    try {
      if (id) sessionStorage.setItem(STORAGE_KEY, id);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return [activeChildId, setActiveChildId];
}
