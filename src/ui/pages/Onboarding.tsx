// First-run onboarding wizard (SPEC §4, D24). Placeholder — replaced by the
// Onboarding build agent. Rendered full-screen while settings.onboarded is
// false; must set onboarded: true when finished.
export default function Onboarding() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <p className="text-sm text-muted">Onboarding is being built.</p>
    </div>
  );
}
