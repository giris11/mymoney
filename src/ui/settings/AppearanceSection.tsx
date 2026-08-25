// Appearance: theme override (SPEC §4 dark/light, manual override) and base
// currency. Base currency changes affect DISPLAY/report conversion only —
// stored amounts never change (SPEC §6).
import { getSettings, updateSettings } from '../../db/db';
import { COMMON_CURRENCIES } from '../../db/seed';
import type { ThemeChoice } from '../../db/types';
import { useLive } from '../../db/useLive';
import { Card, Field, Segmented, Select } from '../kit/kit';
import { useToast } from '../kit/toast';
import { errorMessage, SettingsPage } from './shared';

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function AppearanceSection() {
  const settings = useLive(() => getSettings(), []);
  const { toast } = useToast();
  if (!settings) return null;

  const currencies = COMMON_CURRENCIES.includes(settings.baseCurrency)
    ? COMMON_CURRENCIES
    : [settings.baseCurrency, ...COMMON_CURRENCIES];

  return (
    <SettingsPage title="Appearance" description="How the app looks and totals its money.">
      <Card>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">Theme</span>
          <div>
            <Segmented
              label="Theme"
              options={THEME_OPTIONS}
              value={settings.theme}
              onChange={(theme) => {
                updateSettings({ theme }).catch((e) => toast(errorMessage(e), 'error'));
              }}
            />
          </div>
          <p className="text-xs text-muted">“System” follows your device’s dark/light setting.</p>
        </div>
      </Card>
      <Card>
        <Field
          label="Base currency"
          hint="Used only when displaying totals and reports — amounts stay stored in each account’s own currency and are converted with your manual rates at display time."
        >
          {(id) => (
            <Select
              id={id}
              value={settings.baseCurrency}
              className="max-w-40"
              onChange={(e) => {
                const baseCurrency = e.target.value;
                updateSettings({ baseCurrency })
                  .then(() => toast(`Base currency set to ${baseCurrency}`, 'success'))
                  .catch((err) => toast(errorMessage(err), 'error'));
              }}
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </Card>
    </SettingsPage>
  );
}
