const SVG_NS = 'http://www.w3.org/2000/svg';

type Shape = { d: string; fill?: true } | { circle: [number, number, number]; fill?: true };

/** 24×24 line icons (lucide-style); `fill` shapes are solid glyphs for the type badges. */
const ICONS = {
  task: [{ d: 'M5 12.5l4.5 4.5L19 7.5' }],
  bug: [{ circle: [12, 12, 4.5], fill: true }],
  story: [{ d: 'M7 3.5h10a1 1 0 011 1V21l-6-4.2L6 21V4.5a1 1 0 011-1z', fill: true }],
  epic: [{ d: 'M13.5 2.5L5 13.5h6l-1 8 8.5-11h-6z', fill: true }],
  'p-highest': [{ d: 'M6 11.5l6-6 6 6' }, { d: 'M6 19l6-6 6 6' }],
  'p-high': [{ d: 'M6 15l6-6 6 6' }],
  'p-medium': [{ d: 'M5 9h14' }, { d: 'M5 15h14' }],
  'p-low': [{ d: 'M6 9l6 6 6-6' }],
  'p-lowest': [{ d: 'M6 5l6 6 6-6' }, { d: 'M6 12.5l6 6 6-6' }],
  calendar: [
    { d: 'M7 3v3M17 3v3M4 9h16' },
    { d: 'M5.5 5h13A1.5 1.5 0 0120 6.5v12a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18.5v-12A1.5 1.5 0 015.5 5z' },
  ],
  checklist: [
    { d: 'M9 11.5l2.5 2.5L20 5.5' },
    { d: 'M20 12v6.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18.5v-13A1.5 1.5 0 015.5 4H15' },
  ],
  plus: [{ d: 'M12 5v14M5 12h14' }],
  search: [{ circle: [11, 11, 6.5] }, { d: 'M20 20l-4.2-4.2' }],
  x: [{ d: 'M6 6l12 12M18 6L6 18' }],
  trash: [
    { d: 'M4 7h16M10 11v6M14 11v6' },
    { d: 'M6 7l.9 12.2a1.5 1.5 0 001.5 1.3h7.2a1.5 1.5 0 001.5-1.3L18 7M9 7V4.5h6V7' },
  ],
  external: [
    { d: 'M14 4h6v6M20 4l-9 9' },
    { d: 'M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10' },
  ],
  chevron: [{ d: 'M6 9l6 6 6-6' }],
  check: [{ d: 'M5 12.5l4.5 4.5L19 7.5' }],
  layers: [{ d: 'M12 3l9 5-9 5-9-5 9-5z' }, { d: 'M3 13l9 5 9-5' }],
  archive: [{ d: 'M3.5 5h17v4h-17z' }, { d: 'M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9M10 13h4' }],
  user: [{ circle: [12, 8, 4] }, { d: 'M4.5 20a7.5 7.5 0 0115 0' }],
  message: [
    {
      d: 'M5.5 4h13A1.5 1.5 0 0120 5.5v9a1.5 1.5 0 01-1.5 1.5H11l-4.5 3.5V16h-1A1.5 1.5 0 014 14.5v-9A1.5 1.5 0 015.5 4z',
    },
  ],
  edit: [{ d: 'M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17z' }, { d: 'M14.5 7.5l3 3' }],
  alert: [{ d: 'M12 4l9 16H3z' }, { d: 'M12 10v4M12 17.2v.1' }],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('op-icon');
  for (const shape of ICONS[name] as Shape[]) {
    const node = 'd' in shape ? document.createElementNS(SVG_NS, 'path') : document.createElementNS(SVG_NS, 'circle');
    if ('d' in shape) node.setAttribute('d', shape.d);
    else {
      node.setAttribute('cx', String(shape.circle[0]));
      node.setAttribute('cy', String(shape.circle[1]));
      node.setAttribute('r', String(shape.circle[2]));
    }
    if (shape.fill) {
      node.setAttribute('fill', 'currentColor');
      node.setAttribute('stroke', 'none');
    }
    svg.appendChild(node);
  }
  return svg;
}

export const typeIcon = (type: 'task' | 'story' | 'bug' | 'epic'): IconName => type;
export const priorityIcon = (p: 'highest' | 'high' | 'medium' | 'low' | 'lowest'): IconName => `p-${p}`;
