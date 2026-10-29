import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;
const icon = (paths: ReactNode) => (props: IconProps) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths}</svg>
);

export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const CloseIcon = icon(<path d="M6 6l12 12M18 6 6 18" />);
export const HistoryIcon = icon(<><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><path d="M3 4v4.5h4.5" /><path d="M12 7.5V12l3 2" /></>);
export const ExternalLinkIcon = icon(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>);
export const SettingsIcon = icon(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>);
export const SendIcon = icon(<path d="M12 19V5M6 11l6-6 6 6" />);
export const ArrowDownIcon = icon(<path d="M12 5v14M6 13l6 6 6-6" />);
export const CopyIcon = icon(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5H6a2 2 0 0 0-2 2v9" /></>);
export const CheckIcon = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const TrashIcon = icon(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>);
export const PauseIcon = icon(<path d="M9 6v12M15 6v12" />);
export const PlayIcon = icon(<path d="M8 5.5v13l10-6.5z" fill="currentColor" />);
export const RestartIcon = icon(<><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4 4.5V8h3.5" /></>);
export const StopIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" {...props}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
);
