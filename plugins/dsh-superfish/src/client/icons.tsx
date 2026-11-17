import * as React from 'react';

/**
 * 个人面板与顶栏共用的线性图标。
 * 统一 24 网格、1.5 描边、圆端点，随 currentColor 着色；
 * 尺寸由调用处传入，避免在 CSS 里用字号模拟图标。
 */
export type IconName =
  | 'panel' | 'back' | 'plus' | 'chevron-down' | 'chevron-right'
  | 'clock' | 'calendar' | 'route' | 'check' | 'close'
  | 'board' | 'link' | 'edit' | 'refresh' | 'camera'
  | 'sparkle' | 'cpu' | 'layers' | 'zap' | 'terminal' | 'user'
  | 'list' | 'sliders' | 'copy' | 'archive' | 'calendar-check';

const paths: Record<IconName, React.ReactNode> = {
  panel: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M15 4.5v15" /></>,
  back: <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  clock: <><circle cx="12" cy="12" r="8.25" /><path d="M12 7.5V12l3 1.8" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></>,
  route: <><circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="M8.4 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.6" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  board: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 9h17M9.5 9v10.5" /></>,
  link: <><path d="M14 5h5v5" /><path d="m19 5-8 8" /><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>,
  edit: <><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z" /><path d="m14 7 3 3" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 5v5h-5" /></>,
  camera: <><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></>,
  sparkle: <><path d="M12 3c.7 4.2 2.8 6.3 7 7-4.2.7-6.3 2.8-7 7-.7-4.2-2.8-6.3-7-7 4.2-.7 6.3-2.8 7-7Z" /><path d="M19 16c.3 1.6 1.1 2.4 2.7 2.7-1.6.3-2.4 1.1-2.7 2.7-.3-1.6-1.1-2.4-2.7-2.7 1.6-.3 2.4-1.1 2.7-2.7Z" /></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2.5" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  layers: <><path d="m12 3.5 8.5 4.5L12 12.5 3.5 8 12 3.5Z" /><path d="m3.5 12 8.5 4.5 8.5-4.5" /><path d="m3.5 16 8.5 4.5 8.5-4.5" /></>,
  zap: <path d="M13 2.5 4.5 13.5h6.5L10 21.5l9.5-11.5H13l0-7.5Z" />,
  terminal: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7.5 10 3 2.5-3 2.5M12.5 15h4" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5.5 19.5c1.5-3 4-4.5 6.5-4.5s5 1.5 6.5 4.5" /></>,
  list: <><path d="M9.5 7h10M9.5 12h10M9.5 17h10" /><circle cx="5.25" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="5.25" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="5.25" cy="17" r="1" fill="currentColor" stroke="none" /></>,
  sliders: <><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="17" r="2" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" /></>,
  'calendar-check': <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /><path d="m9 14.5 2 2 4-4" /></>,
};

export function Icon({ name, size = 16, strokeWidth = 1.5, className }: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}): React.ReactElement {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
