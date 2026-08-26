// The one-off Google Cloud setup, on screen (SPEC §8.3 / D42).
//
// This app ships no credential of its own — a browser app cannot keep a client
// secret, and there is no server of ours to keep one on — so the user creates
// an OAuth client in their own Google account. That is genuinely fiddly, and
// sending someone to a markdown file in the repo to do it is not an answer, so
// the steps live here, collapsed until asked for.
import { useState } from 'react';
import { IconButton } from '../kit/kit';
import { IconCheck, IconChevronRight, type IconProps } from '../kit/icons';
import { useToast } from '../kit/toast';

/** Two overlapping sheets — kit has no copy icon. */
const IconCopy = ({ size = 16, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

/** The exact string Google wants under "Authorised JavaScript origins". */
export function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function CopyableOrigin({ origin }: { origin: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(origin);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy — select the address and copy it by hand.', 'info');
    }
  };
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <code className="rounded border border-border bg-surface2 px-1.5 py-0.5 text-xs text-text">
        {origin}
      </code>
      <IconButton label={`Copy ${origin}`} className="p-1" onClick={() => void copy()}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </IconButton>
      {copied && <span className="text-xs text-pos">Copied</span>}
    </span>
  );
}

export default function DriveSetupSteps() {
  const origin = currentOrigin();
  return (
    <details className="group rounded-lg border border-border bg-surface2/50">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-text [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5">
          <IconChevronRight size={14} className="transition-transform group-open:rotate-90" />
          How to get a client ID (one-off, about five minutes)
        </span>
      </summary>
      <div className="border-t border-border px-3 py-3 text-sm text-muted">
        <p className="max-w-prose">
          You are creating a Google project of your own, so the app talks to{' '}
          <strong className="text-text">your</strong> Drive with{' '}
          <strong className="text-text">your</strong> permission. Nothing here costs anything, and
          nothing you create is shared with anyone.
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 marker:text-faint">
          <li>
            Go to <span className="text-text">console.cloud.google.com</span> and sign in with the
            Google account whose Drive should hold the file.
          </li>
          <li>Create a project. The name is only for you — “MyMoney” is fine.</li>
          <li>
            Open <span className="text-text">APIs &amp; Services → Library</span>, search for{' '}
            <span className="text-text">Google Drive API</span>, and press{' '}
            <span className="text-text">Enable</span>.
          </li>
          <li>
            Open <span className="text-text">APIs &amp; Services → OAuth consent screen</span>.
            Choose <span className="text-text">External</span>, give it any app name and your own
            email, and add your own Google address under{' '}
            <span className="text-text">Test users</span>.
          </li>
          <li>
            Open <span className="text-text">Credentials → Create credentials → OAuth client ID</span>{' '}
            and choose application type <span className="text-text">Web application</span>.
          </li>
          <li>
            Under <span className="text-text">Authorised JavaScript origins</span>, add this
            address exactly:
            {origin && <CopyableOrigin origin={origin} />}
            <span className="mt-1 block text-xs">
              This is per address, not per device — every device that opens the app at this address
              is covered. Add a second origin only if you also run the app somewhere else.
            </span>
          </li>
          <li>
            Press <span className="text-text">Create</span> and copy the{' '}
            <span className="text-text">Client ID</span> — it ends in{' '}
            <code className="text-xs">.apps.googleusercontent.com</code>. Google will also show a{' '}
            <strong className="text-text">client secret</strong>: ignore it. This app never uses
            one, and no web app can keep a secret private anyway.
          </li>
          <li>Paste the client ID into the box above and press Connect.</li>
        </ol>
        <p className="mt-3 max-w-prose text-xs">
          Your project stays in “Testing” mode, which is right for personal use and costs nothing.
          The trade-off is that Google expires the permission periodically, so once in a while
          you’ll be asked to sign in again. Your data is unaffected — it just means the next sync
          asks for permission first.
        </p>
      </div>
    </details>
  );
}
