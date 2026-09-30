import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './Button';
import { IconButton } from './IconButton';

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Optional trigger element (rendered with asChild). Without it, focus returns to whatever opened the dialog. */
  readonly trigger?: ReactNode;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}

/** Radix Dialog: focus trap, Esc closes, focus returns to the opener (09 I3 `.dialog`). */
export function Dialog({ open, onOpenChange, title, description, trigger, footer, children }: DialogProps) {
  const returnFocusTo = useRef<HTMLElement | null>(null);
  // Remember the opener when the dialog opens (Radix only restores focus to its own Trigger).
  // Layout effects run before Radix's FocusScope moves focus into the dialog.
  useLayoutEffect(() => {
    if (open) returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger === undefined ? null : <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop" />
        <RadixDialog.Content
          className="dialog"
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          onCloseAutoFocus={(event) => {
            const target = returnFocusTo.current;
            returnFocusTo.current = null;
            if (trigger === undefined && target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="card-header">
            <RadixDialog.Title asChild>
              <h2>{title}</h2>
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <IconButton label="Close dialog" icon={X} size="sm" />
            </RadixDialog.Close>
          </div>
          {description === undefined ? null : (
            <RadixDialog.Description asChild>
              <div className="muted">{description}</div>
            </RadixDialog.Description>
          )}
          {children}
          {footer === undefined ? null : <footer>{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  /** What will happen, in plain words (e.g. "Finished steps are kept. The in-flight request is finished first."). */
  readonly consequences: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly trigger?: ReactNode;
}

/** For destructive actions only (§5.7: no confirmations for read-only actions). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequences,
  confirmLabel,
  cancelLabel = 'Keep going',
  destructive = true,
  pending = false,
  onConfirm,
  trigger,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={consequences}
      {...(trigger === undefined ? {} : { trigger })}
      footer={
        <>
          <RadixDialog.Close asChild>
            <Button variant="secondary" disabled={pending}>
              {cancelLabel}
            </Button>
          </RadixDialog.Close>
          <Button variant={destructive ? 'danger' : 'primary'} pending={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
