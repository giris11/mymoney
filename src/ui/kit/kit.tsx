// Shared UI kit. Every interactive control is keyboard-usable and labelled
// (SPEC §9 accessibility). Colours come exclusively from the semantic palette
// in styles.css so both themes stay AA.
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/util';
import { formatMinor, parseAmountToMinor, formatMinorPlain } from '../../money/money';
import { IconX } from './icons';

// ---------------------------------------------------------------- Button
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}
const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:opacity-90 border border-transparent',
  secondary: 'bg-surface text-text border border-border hover:bg-surface2',
  ghost: 'bg-transparent text-text hover:bg-surface2 border border-transparent',
  danger: 'bg-danger text-white hover:opacity-90 border border-transparent dark:text-[#2b0f0f]',
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
        size === 'sm' ? 'px-2.5 py-1.5 text-sm' : 'px-3.5 py-2 text-sm',
        buttonStyles[variant],
        className,
      )}
      {...rest}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string; // accessible name — required
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-lg p-2 text-muted hover:bg-surface2 hover:text-text transition-colors cursor-pointer disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
});

// ---------------------------------------------------------------- Inputs
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-faint',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text',
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex items-center gap-2 text-sm', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-(--c-accent)"
      />
      <span>{label}</span>
    </label>
  );
}

/** Label + control + optional hint/error, correctly associated. */
export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode | ((id: string) => ReactNode);
  htmlFor?: string;
  className?: string;
}) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {typeof children === 'function' ? children(id) : children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Segmented
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex rounded-lg border border-border bg-surface2 p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors cursor-pointer',
            value === o.value ? 'bg-surface text-text shadow-sm font-medium' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Modal
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // move focus into the dialog
    const t = setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(
        'input, select, textarea, button:not([data-modal-close])',
      );
      (el ?? panelRef.current)?.focus();
    }, 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface shadow-xl',
          'rounded-t-2xl sm:rounded-2xl sm:border sm:border-border',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton label="Close" data-modal-close onClick={onClose}>
            <IconX size={18} />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border px-4 py-3 safe-bottom">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  requireText,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** e.g. 'RESTORE' — user must type it to enable the confirm button (D21). */
  requireText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const blocked = !!requireText && typed !== requireText;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={blocked}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-text">
        <div>{message}</div>
        {requireText && (
          <Field label={`Type ${requireText} to confirm`}>
            {(id) => (
              <Input
                id={id}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Money
/** Money amount with tabular figures; income green, expense red (optional). */
export function Amount({
  minor,
  currency,
  signColour = false,
  className,
}: {
  minor: number;
  currency: string;
  signColour?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'tnum',
        signColour && minor > 0 && 'text-pos',
        signColour && minor < 0 && 'text-neg',
        className,
      )}
    >
      {formatMinor(minor, currency)}
    </span>
  );
}

/**
 * Amount input working in minor units. Shows/edits a decimal string; reports
 * integer minor units (or null while invalid/empty) via onValue.
 */
export function MoneyInput({
  id,
  valueMinor,
  currency,
  onValue,
  placeholder,
  autoFocus,
  className,
  'aria-label': ariaLabel,
}: {
  id?: string;
  valueMinor: number | null;
  currency: string;
  onValue: (minor: number | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const [text, setText] = useState(valueMinor === null ? '' : formatMinorPlain(valueMinor, currency));
  const lastReported = useRef(valueMinor);
  // adopt external changes (e.g. form reset)
  useEffect(() => {
    if (valueMinor !== lastReported.current) {
      setText(valueMinor === null ? '' : formatMinorPlain(valueMinor, currency));
      lastReported.current = valueMinor;
    }
  }, [valueMinor, currency]);
  return (
    <Input
      id={id}
      inputMode="decimal"
      autoFocus={autoFocus}
      placeholder={placeholder ?? '0.00'}
      aria-label={ariaLabel}
      className={cn('tnum', className)}
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const parsed = t.trim() === '' ? null : parseAmountToMinor(t, currency);
        lastReported.current = parsed;
        onValue(parsed);
      }}
    />
  );
}

// ---------------------------------------------------------------- Misc
export function ProgressBar({
  value,
  over,
  className,
}: {
  value: number; // 0..1+, clamped visually at 1
  over?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.max(0, value) * 100)}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface2', className)}
    >
      <div
        className={cn('h-full rounded-full transition-all', over ? 'bg-danger' : 'bg-accent')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <h3 className="text-base font-semibold text-text">{title}</h3>
      {message && <p className="max-w-sm text-sm text-muted">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-surface2 px-2 py-0.5 text-xs text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-border bg-surface p-4', className)}>{children}</div>
  );
}
