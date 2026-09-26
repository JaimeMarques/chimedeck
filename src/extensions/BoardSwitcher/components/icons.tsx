// Pin icons — heroicons has no pin glyph, so these follow its 24/outline style.
import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  'aria-hidden': true,
};

const PIN_PATH = 'M9 3.75h6M10.5 3.75v5.25L7.5 12.75v1.5h9v-1.5L13.5 9V3.75M12 14.25v6';

export const PinIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d={PIN_PATH} />
  </svg>
);

export const PinSlashIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d={`${PIN_PATH}M3.75 3.75l16.5 16.5`} />
  </svg>
);
