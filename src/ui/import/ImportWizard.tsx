// Import wizard (SPEC §7): file → detect/map → MANDATORY preview → commit.
// CONTRACT — implemented by the Import-UI build agent. Used from Settings and
// Onboarding.
export interface ImportWizardProps {
  onDone: () => void;
  onCancel: () => void;
}

export default function ImportWizard(_props: ImportWizardProps) {
  return null; // placeholder — implemented by the Import-UI agent
}
