// Hash router (D3): works on GitHub Pages subpaths and file:// alike.
import { useEffect, useState } from 'react';

export interface Route {
  path: string; // e.g. '/transactions'
  params: URLSearchParams;
}

function parseHash(): Route {
  const h = window.location.hash.replace(/^#/, '') || '/dashboard';
  const [rawPath, query = ''] = h.split('?');
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return { path, params: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to.startsWith('#') ? to.slice(1) : to;
}

/** For <a href={href('/reports')}> links. */
export const href = (to: string): string => `#${to}`;
