/**
 * icons — lucide wrapper. Bundled locally via npm (no CDN).
 * All icons render at 16px, stroke 1.5.
 */

import {
  createElement,
  type IconNode,
  Play,
  Orbit,
  Hand,
  House,
  Ruler,
  Search,
  Copy,
  Trash2,
  Download,
  Info,
  X,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  LoaderCircle,
  CircleCheck,
  TriangleAlert,
  CircleX,
  Circle,
  Video,
  FileText,
  FileJson,
  FileBox,
  Terminal,
  Layers,
  Package,
  Keyboard,
  Gpu,
  PanelLeft,
  PanelRight,
  PanelBottom,
  RotateCcw,
  Grid3x3,
  Box,
  Scan,
  Crosshair,
  Database,
  FileVideo,
  FolderOpen,
  Camera,
  Image,
  FileDown,
  Square,
  Waypoints,
  Mountain,
  CircleDot,
  ArrowRight,
  SlidersHorizontal,
  RefreshCw,
  Minus,
  FileUp,
} from 'lucide';

const REGISTRY: Record<string, IconNode> = {
  play: Play,
  orbit: Orbit,
  hand: Hand,
  house: House,
  ruler: Ruler,
  search: Search,
  copy: Copy,
  trash: Trash2,
  download: Download,
  info: Info,
  x: X,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  spinner: LoaderCircle,
  'check-circle': CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
  circle: Circle,
  video: Video,
  'file-text': FileText,
  'file-json': FileJson,
  'file-box': FileBox,
  terminal: Terminal,
  layers: Layers,
  package: Package,
  keyboard: Keyboard,
  gpu: Gpu,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  'panel-bottom': PanelBottom,
  'rotate-ccw': RotateCcw,
  grid: Grid3x3,
  box: Box,
  scan: Scan,
  crosshair: Crosshair,
  database: Database,
  'file-video': FileVideo,
  'folder-open': FolderOpen,
  camera: Camera,
  image: Image,
  'file-down': FileDown,
  square: Square,
  waypoints: Waypoints,
  mountain: Mountain,
  'circle-dot': CircleDot,
  'arrow-right': ArrowRight,
  sliders: SlidersHorizontal,
  refresh: RefreshCw,
  minus: Minus,
  'file-up': FileUp,
};

export type IconName = keyof typeof REGISTRY;

export function icon(name: IconName | string, size = 16): SVGSVGElement {
  const node = REGISTRY[name];
  const svg = createElement(node ?? Circle, {
    width: size,
    height: size,
    'stroke-width': 1.5,
  }) as SVGSVGElement;
  svg.classList.add('lucide');
  return svg;
}

/** Create a DOM element quickly. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
