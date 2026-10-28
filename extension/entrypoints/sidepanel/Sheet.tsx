import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './icons';

export default function Sheet({ open, title, onClose, children }: {
  open: boolean; title: string; onClose(): void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  return <dialog ref={dialog} className="sheet" aria-label={title} onClose={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="sheet-header">
      <h2>{title}</h2>
      <button type="button" className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><CloseIcon /></button>
    </header>
    <div className="sheet-body">{children}</div>
  </dialog>;
}
