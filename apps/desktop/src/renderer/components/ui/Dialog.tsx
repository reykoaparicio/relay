import { useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
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
  /**
   * Where focus goes on close when the opener can no longer take it (it was disabled by a pending
   * action or unmounted by the decision). Typically the owning card's heading with `tabIndex={-1}`.
   */
  readonly returnFocusFallback?: RefObject<HTMLElement | null>;
}

/** True when `el` is still in the document and can take focus (not disabled, not inside `inert`). */
function canReceiveFocus(el: HTMLElement | null | undefined): el is HTMLElement {
  return el?.isConnected === true && !el.matches(':disabled') && el.closest('[inert]') === null;
}

/** Radix Dialog: focus trap, Esc closes, focus returns to the opener or a fallback (09 I3 `.dialog`). */
export function Dialog({ open, onOpenChange, title, description, trigger, footer, children, returnFocusFallback }: DialogProps) {
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
            const opener = returnFocusTo.current;
            returnFocusTo.current = null;
            // Never drop focus to <body>: a confirmed action often disables or removes its opener.
            const fallback = returnFocusFallback?.current;
            const destination = canReceiveFocus(opener) ? opener : canReceiveFocus(fallback) ? fallback : null;
            if (destination === null) return;
            event.preventDefault();
            destination.focus();
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
  /** See {@link DialogProps.returnFocusFallback}. */
  readonly returnFocusFallback?: RefObject<HTMLElement | null>;
  /**
   * A safer alternative offered beside the confirm button (e.g. "Archive instead"). While it or the confirm is
   * pending, every footer button is disabled.
   */
  readonly secondaryAction?: ConfirmSecondaryAction;
  /**
   * Body content that is not part of the dialog's accessible description (warnings, the mutation error), so the
   * description stays the plain consequences sentence.
   */
  readonly children?: ReactNode;
}

export interface ConfirmSecondaryAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly pending?: boolean;
}

export interface DialogCloseProps {
  /** A custom control (rendered with asChild). Without it, a secondary `Button` labelled `label`. */
  readonly children?: ReactNode;
  /** Label of the default button (default "Cancel"). Ignored when `children` is given. */
  readonly label?: string;
  readonly disabled?: boolean;
}

/** Closes the enclosing `Dialog` (Radix Close). Focus then returns to the opener or the fallback. */
export function DialogClose({ children, label = 'Cancel', disabled = false }: DialogCloseProps) {
  return (
    <RadixDialog.Close asChild>
      {children ?? (
        <Button variant="secondary" disabled={disabled}>
          {label}
        </Button>
      )}
    </RadixDialog.Close>
  );
}

export interface DialogFooterProps {
  /** Primary action label (e.g. "Increase allowance"). */
  readonly primaryLabel: string;
  /**
   * The `id` of a `<form>` in the dialog body. The primary button becomes `type="submit" form={formId}`,
   * so Enter in a field and the button both submit through the form's own `onSubmit`.
   */
  readonly formId?: string;
  /** Click handler for the primary button when there is no `formId` (or in addition to submitting). */
  readonly onPrimary?: () => void;
  readonly primaryVariant?: 'primary' | 'danger';
  /** Disables the primary button (e.g. nothing chosen yet). */
  readonly primaryDisabled?: boolean;
  /** Secondary action label (default "Cancel"). */
  readonly secondaryLabel?: string;
  /** Secondary click handler. Without it, the secondary button simply closes the dialog. */
  readonly onSecondary?: () => void;
  /** Request in flight: the primary shows a spinner + aria-busy, the secondary is disabled. */
  readonly pending?: boolean;
}

/**
 * Standard dialog footer: secondary (Cancel) then primary, with pending and form-submit support.
 * Pass it as `<Dialog footer={<DialogFooter … />}>`; it must render inside a `Dialog`.
 */
export function DialogFooter({
  primaryLabel,
  formId,
  onPrimary,
  primaryVariant = 'primary',
  primaryDisabled = false,
  secondaryLabel = 'Cancel',
  onSecondary,
  pending = false,
}: DialogFooterProps) {
  return (
    <>
      {onSecondary === undefined ? (
        <DialogClose label={secondaryLabel} disabled={pending} />
      ) : (
        <Button variant="secondary" disabled={pending} onClick={onSecondary}>
          {secondaryLabel}
        </Button>
      )}
      <Button
        variant={primaryVariant}
        type={formId === undefined ? 'button' : 'submit'}
        {...(formId === undefined ? {} : { form: formId })}
        {...(onPrimary === undefined ? {} : { onClick: onPrimary })}
        pending={pending}
        disabled={primaryDisabled}
      >
        {primaryLabel}
      </Button>
    </>
  );
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
  returnFocusFallback,
  secondaryAction,
  children,
}: ConfirmDialogProps) {
  const anyPending = pending || secondaryAction?.pending === true;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={consequences}
      {...(trigger === undefined ? {} : { trigger })}
      {...(returnFocusFallback === undefined ? {} : { returnFocusFallback })}
      footer={
        secondaryAction === undefined ? (
          <DialogFooter
            primaryLabel={confirmLabel}
            primaryVariant={destructive ? 'danger' : 'primary'}
            secondaryLabel={cancelLabel}
            pending={pending}
            onPrimary={onConfirm}
          />
        ) : (
          <>
            <DialogClose label={cancelLabel} disabled={anyPending} />
            <Button variant="secondary" pending={secondaryAction.pending === true} disabled={anyPending} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
            <Button variant={destructive ? 'danger' : 'primary'} pending={pending} disabled={anyPending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </>
        )
      }
    >
      {children}
    </Dialog>
  );
}
