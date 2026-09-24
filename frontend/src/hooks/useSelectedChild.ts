import { useContext } from "react";
import { SelectedChildContext } from "@/contexts/SelectedChildContext";

export function useSelectedChild() {
  const ctx = useContext(SelectedChildContext);
  if (ctx === undefined) throw new Error("useSelectedChild must be used within a SelectedChildProvider");
  return ctx;
}
