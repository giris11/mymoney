// Duplicate glyph, drawn in the shared kit's house style (24×24, 1.8 stroke,
// currentColor). Only the register row and the editor footer use it, so it
// stays local to the transactions folder rather than growing the shared set.
import type { SVGProps } from 'react';

export function IconCopy({ size = 20, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
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
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M15 5.5V5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H6" />
    </svg>
  );
}
