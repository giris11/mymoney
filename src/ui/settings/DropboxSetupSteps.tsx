// Using YOUR OWN Dropbox app instead of the built-in one, on screen.
//
// This is OPTIONAL, and that is the difference from the Drive version of this
// component (D42/SPEC §8.3). Google gave a browser app no usable public
// credential, so the owner had to create a Cloud project and paste a client ID
// before sync would work at all; these steps were the only way to make the
// feature usable. Dropbox publishes the app key as safe for client-side code,
// so MyMoney ships its own and the normal path is just "press Connect".
//
// What is left here is for one case: an owner who would rather the app talked
// to a Dropbox app registered in his own name. The steps stay on screen rather
// than in a markdown file because the console has one genuine trap in it —
// THE APP SECRET SITS DIRECTLY BELOW THE APP KEY AND LOOKS IDENTICAL. Both are
// fifteen lowercase alphanumeric characters, so nothing can validate the
// difference (see appKeyError); only the label on the console page and the
// warning below can.
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

/**
 * The exact string Dropbox wants under "Redirect URIs" — the DIRECTORY this
 * app is served from, trailing slash included.
 *
 * Not the origin, which is what Google's "Authorised JavaScript origins" took.
 * Dropbox matches a redirect URI character for character, and this app is
 * served from a subpath on GitHub Pages, so the path has to be there. This is
 * the same computation `defaultRedirectUri()` does in src/sync/dropboxAuth.ts,
 * deliberately: what the owner is told to register is what the app will send.
 */
export function currentRedirectUri(): string {
  if (typeof window === 'undefined') return '';
  const { origin, pathname } = window.location;
  return `${origin}${pathname.slice(0, pathname.lastIndexOf('/') + 1)}`;
}

function CopyableValue({ value }: { value: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy — select the address and copy it by hand.', 'info');
    }
  };
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <code className="rounded border border-border bg-surface2 px-1.5 py-0.5 text-xs text-text">
        {value}
      </code>
      <IconButton label={`Copy ${value}`} className="p-1" onClick={() => void copy()}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </IconButton>
      {copied && <span className="text-xs text-pos">Copied</span>}
    </span>
  );
}

export default function DropboxSetupSteps() {
  const redirect = currentRedirectUri();
  return (
    <details className="group rounded-lg border border-border bg-surface2/50">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-text [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5">
          <IconChevronRight size={14} className="transition-transform group-open:rotate-90" />
          Use my own Dropbox app instead (optional, about five minutes)
        </span>
      </summary>
      <div className="border-t border-border px-3 py-3 text-sm text-muted">
        <p className="max-w-prose">
          <strong className="text-text">You do not need to do this.</strong> MyMoney has its own
          Dropbox app key built in, and it is public by design — it identifies the app and grants
          nothing on its own. Follow these steps only if you would rather the connection was
          registered in your own Dropbox account.
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 marker:text-faint">
          <li>
            Go to <span className="text-text">dropbox.com/developers/apps</span> and sign in with
            the Dropbox account that should hold the file.
          </li>
          <li>
            Press <span className="text-text">Create app</span>. Choose{' '}
            <span className="text-text">Scoped access</span>, then{' '}
            <span className="text-text">App folder</span> — not “Full Dropbox”. App folder means
            the app can only ever see the one folder Dropbox creates for it, and the rest of your
            Dropbox stays invisible to it.
          </li>
          <li>Name it anything you like — the name is only for you.</li>
          <li>
            On the app’s <span className="text-text">Permissions</span> tab, tick exactly four:{' '}
            <code className="break-all text-xs">account_info.read</code>,{' '}
            <code className="break-all text-xs">files.metadata.read</code>,{' '}
            <code className="break-all text-xs">files.content.read</code>,{' '}
            <code className="break-all text-xs">files.content.write</code>. Press{' '}
            <span className="text-text">Submit</span>. Nothing else is needed, and MyMoney will
            refuse a sign-in that comes back with less.
          </li>
          <li>
            Back on <span className="text-text">Settings</span>, set{' '}
            <span className="text-text">Public clients (Implicit Grant &amp; PKCE)</span> to{' '}
            <span className="text-text">Allow</span>. That is what lets a browser sign in without a
            secret.
          </li>
          <li>
            Under <span className="text-text">Redirect URIs</span>, add this address exactly —
            including the slash at the end:
            {redirect && <CopyableValue value={redirect} />}
            <span className="mt-1 block text-xs">
              Dropbox matches this character for character. It is per address, not per device:
              every device that opens the app at this address is covered. Add a second one only if
              you also run the app somewhere else.
            </span>
          </li>
          <li>
            Copy the <strong className="text-text">App key</strong> from the top of that page and
            paste it into the box above.
          </li>
        </ol>
        {/* The one mistake this panel exists to prevent, in its own box because
            a sentence in a list is not enough: the console prints "App secret"
            immediately under "App key", both are fifteen lowercase
            alphanumeric characters, and no validation can tell them apart. */}
        <p className="mt-3 max-w-prose rounded-lg border border-warn bg-surface2 p-3 text-sm text-text">
          <strong>Do not paste the app secret.</strong> Dropbox shows an{' '}
          <span className="font-semibold">App secret</span> directly underneath the app key, and
          the two look identical — both are fifteen letters and digits, so nothing in this app can
          tell them apart for you. MyMoney never uses a secret, never sends one, and never asks for
          one: a web app cannot keep one private, so a secret pasted here would be stored on your
          device for no benefit whatsoever. Copy the value under the words{' '}
          <span className="font-semibold">App key</span>.
        </p>
        <p className="mt-3 max-w-prose text-xs">
          Your app stays in <span className="text-text">Development</span> status, which is right
          for personal use and costs nothing — it only ever serves you, its own owner. The full
          write-up is in <code className="text-xs">docs/DROPBOX-SETUP.md</code>.
        </p>
      </div>
    </details>
  );
}
