import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as RadixToast from '@radix-ui/react-toast';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { IconButton } from './IconButton';

/** §5.1 "no repeated generic toast spam": a key shown within this window is not shown again. */
export const TOAST_DEDUPE_MS = 10_000;
const TOAST_DURATION_MS = 8_000;

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastInput {
  /** Dedupe key, e.g. `${code}:${runId}`. */
  readonly key: string;
  readonly title: string;
  readonly body?: string;
  readonly tone?: ToastTone;
  /** Actionable failures only: the toast should say what the user can do. */
  readonly action?: { readonly label: string; readonly onAction: () => void };
}

interface ToastEntry extends ToastInput {
  readonly id: number;
}

interface ToastApi {
  /** Returns false when the toast was suppressed as a duplicate. */
  readonly show: (toast: ToastInput) => boolean;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_ICON: Record<ToastTone, LucideIcon> = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleX };

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** Injected clock for deterministic dedupe tests (00b §2.4). */
  readonly now?: () => number;
}

export function ToastProvider({ children, now = Date.now }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ToastEntry[]>([]);
  const lastShown = useRef(new Map<string, number>());
  const nextId = useRef(1);

  const show = useCallback(
    (toast: ToastInput) => {
      const t = now();
      const previous = lastShown.current.get(toast.key);
      if (previous !== undefined && t - previous < TOAST_DEDUPE_MS) return false;
      lastShown.current.set(toast.key, t);
      const id = nextId.current++;
      setToasts((list) => [...list.filter((x) => x.key !== toast.key), { ...toast, id }]);
      return true;
    },
    [now],
  );
  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider duration={TOAST_DURATION_MS} label="Notification">
        {children}
        {toasts.map((toast) => {
          const tone = toast.tone ?? 'info';
          const Icon = TONE_ICON[tone];
          return (
            <RadixToast.Root
              key={toast.id}
              className={`toast ${tone}`}
              type={tone === 'danger' ? 'foreground' : 'background'}
              onOpenChange={(open) => { if (!open) dismiss(toast.id); }}
            >
              <Icon aria-hidden="true" />
              <div className="body">
                <RadixToast.Title className="small" style={{ fontWeight: 600 }}>
                  {toast.title}
                </RadixToast.Title>
                {toast.body === undefined ? null : (
                  <RadixToast.Description className="small muted">{toast.body}</RadixToast.Description>
                )}
                {toast.action === undefined ? null : (
                  <RadixToast.Action asChild altText={toast.action.label}>
                    <button type="button" className="btn sm" onClick={toast.action.onAction}>
                      {toast.action.label}
                    </button>
                  </RadixToast.Action>
                )}
              </div>
              <RadixToast.Close asChild>
                <IconButton label="Dismiss notification" icon={X} size="sm" />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}
        <RadixToast.Viewport className="toast-region" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
