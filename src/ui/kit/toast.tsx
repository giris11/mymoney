// Lightweight toast notifications (aria-live so screen readers hear them).
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/util';

export type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind, action?: ToastItem['action']) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {} });

export const useToast = (): ToastApi => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback<ToastApi['toast']>((message, kind = 'info', action) => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-3), { id, kind, message, action }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, action ? 8000 : 4000);
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-lg',
              'bg-surface text-text',
              t.kind === 'success' && 'border-pos',
              t.kind === 'error' && 'border-danger',
              t.kind === 'info' && 'border-border',
            )}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="font-semibold text-accent cursor-pointer"
                onClick={() => {
                  t.action?.onClick();
                  setItems((prev) => prev.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
