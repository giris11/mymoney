// Quick add (SPEC §4: log an expense in ~3 seconds). CONTRACT — implemented by
// the Transactions build agent. Mounted once in App; FAB/sidebar open it.
export interface QuickAddSheetProps {
  open: boolean;
  onClose: () => void;
}

export default function QuickAddSheet({ open }: QuickAddSheetProps) {
  if (!open) return null;
  return null; // placeholder — implemented by the Transactions page agent
}
