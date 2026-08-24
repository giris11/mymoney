// Small inline icon set — 24×24 stroke icons, no icon dependency.
import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Base({ size = 20, children, ...rest }: IconProps) {
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
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.5" />
  </Base>
);
export const IconList = (p: IconProps) => (
  <Base {...p}>
    <path d="M8.5 6h12M8.5 12h12M8.5 18h12" />
    <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
  </Base>
);
export const IconPie = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3a9 9 0 1 0 9 9h-9V3Z" />
    <path d="M15 3.5A9 9 0 0 1 20.5 9H15V3.5Z" />
  </Base>
);
export const IconWallet = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="6" width="18" height="14" rx="2.5" />
    <path d="M3 9.5h18" />
    <circle cx="16.5" cy="15" r="1" fill="currentColor" stroke="none" />
  </Base>
);
export const IconGear = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
  </Base>
);
export const IconPlus = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);
export const IconSearch = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </Base>
);
export const IconX = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Base>
);
export const IconChevronDown = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 9 6 6 6-6" />
  </Base>
);
export const IconChevronRight = (p: IconProps) => (
  <Base {...p}>
    <path d="m9 6 6 6-6 6" />
  </Base>
);
export const IconChevronLeft = (p: IconProps) => (
  <Base {...p}>
    <path d="m15 6-6 6 6 6" />
  </Base>
);
export const IconTransfer = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5" />
    <path d="M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5" />
  </Base>
);
export const IconTag = (p: IconProps) => (
  <Base {...p}>
    <path d="M3.5 12.5v-8a1 1 0 0 1 1-1h8L21 12l-8.5 8.5L3.5 12.5Z" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
  </Base>
);
export const IconCalendar = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="16" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Base>
);
export const IconUpload = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5" />
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Base>
);
export const IconDownload = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4v11m0 0 4.5-4.5M12 15 7.5 10.5" />
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Base>
);
export const IconTrash = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l1 13a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-13" />
    <path d="M10 11.5v5M14 11.5v5" />
  </Base>
);
export const IconPencil = (p: IconProps) => (
  <Base {...p}>
    <path d="m4 20 .8-3.2L16.6 5a1.5 1.5 0 0 1 2.1 0l.3.3a1.5 1.5 0 0 1 0 2.1L7.2 19.2 4 20Z" />
  </Base>
);
export const IconCheck = (p: IconProps) => (
  <Base {...p}>
    <path d="m5 13 4.5 4.5L19 7" />
  </Base>
);
export const IconAlert = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4 2.8 20h18.4L12 4Z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.3" r="0.9" fill="currentColor" stroke="none" />
  </Base>
);
export const IconMoon = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
  </Base>
);
export const IconSun = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" />
  </Base>
);
export const IconFilter = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z" />
  </Base>
);
export const IconTrendUp = (p: IconProps) => (
  <Base {...p}>
    <path d="m3 17 6-6 4 4 8-8" />
    <path d="M16 7h5v5" />
  </Base>
);
export const IconCoins = (p: IconProps) => (
  <Base {...p}>
    <ellipse cx="12" cy="6.5" rx="7" ry="3" />
    <path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
    <path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
  </Base>
);
export const IconDots = (p: IconProps) => (
  <Base {...p}>
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
  </Base>
);
export const IconUndo = (p: IconProps) => (
  <Base {...p}>
    <path d="M8 5 4 9l4 4" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </Base>
);
export const IconShield = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3 5 5.5v6c0 4.5 3 7.8 7 9.5 4-1.7 7-5 7-9.5v-6L12 3Z" />
  </Base>
);
