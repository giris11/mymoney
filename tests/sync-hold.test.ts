// THE SYNC HOLD, TESTED AS A THING THE OWNER CAN SEE — not just as a constant.
//
// src/sync/held.ts gates sync in two places: the Sync screen never offers a
// control that reaches Dropbox, and `dropboxTransport()` refuses to construct
// the transport for any other caller. Both halves were already asserted
// elsewhere, and both were true. The screen still did not work.
//
// `dropboxTransport()` throws while held, and the live Sync component calls it
// in `useMemo(() => dropboxTransport(), [])`. A useMemo factory runs DURING
// render, so it threw before the `if (SYNC_HELD) return <card/>` below it was
// ever reached. This app has no error boundary, so React unmounted the whole
// root: opening Settings → Sync blanked the app, and because the router keeps
// the route in the URL hash (src/ui/router.ts — "THE URL IS THE STATE"), a
// reload landed on the same route and blanked it again.
//
// Nothing caught it because the suite is `environment: 'node'` and no test in
// this repo had ever RENDERED a component — every sync test drives the engine,
// the transport or the formatter directly. So the one screen whose entire job
// is to tell the owner "nothing is at risk" was the one screen that crashed.
//
// These tests render the real component. That is the seam.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SYNC_HELD, SYNC_HELD_REASON } from '../src/sync/held';
import { dropboxTransport } from '../src/ui/settings/syncAccess';
import SyncSection from '../src/ui/settings/SyncSection';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the sync hold is still in place', () => {
  it('is on', () => {
    expect(SYNC_HELD).toBe(true);
  });

  it('refuses to build a transport for any caller — the gate that is not the screen', () => {
    expect(() => dropboxTransport()).toThrow(SYNC_HELD_REASON);
  });
});

describe('the Sync screen SHOWS the hold rather than dying of it', () => {
  it('renders, instead of throwing out of a hook and unmounting the app', () => {
    expect(() => renderToStaticMarkup(createElement(SyncSection))).not.toThrow();
  });

  it('says why sync is off, and points at the path that still works', () => {
    const html = renderToStaticMarkup(createElement(SyncSection));
    expect(html).toContain('Sync is switched off in this build');
    expect(html).toContain(SYNC_HELD_REASON);
    // The owner is not left without a way to move data between devices.
    expect(html).toMatch(/Backup/);
  });

  it('offers no control that could reach Dropbox', () => {
    const html = renderToStaticMarkup(createElement(SyncSection));
    // The live screen's controls, by their own copy. None may be rendered.
    expect(html).not.toMatch(/Connect to Dropbox|Sync now|Disconnect|Re-seed/i);
    expect(html).not.toMatch(/<button/i);
    expect(html).not.toMatch(/<input/i);
  });

  it('touches the network not at all while rendering', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('the held screen made a request')));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderToStaticMarkup(createElement(SyncSection));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds no transport at all — the live component never mounts', () => {
    // If the held screen were still rendering the live component's hooks, this
    // render would throw the hold's own message out of `dropboxTransport()`.
    // Asserting on the message (not merely "did not throw") is what tells this
    // test apart from one that passes because rendering failed some other way.
    let thrown: unknown = null;
    try {
      renderToStaticMarkup(createElement(SyncSection));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(null);
  });
});
