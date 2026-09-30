import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton } from './IconButton';
import { useLiveRegion } from './LiveRegion';

const COPIED_FEEDBACK_MS = 1_500;

export interface CopyButtonProps {
  readonly value: string;
  /** Accessible name, e.g. "Copy plan hash". */
  readonly label: string;
}

/** Copies `value` and announces "Copied" through the app live region. */
export function CopyButton({ value, label }: CopyButtonProps) {
  const { announce } = useLiveRegion();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => { setCopied(false); }, COPIED_FEEDBACK_MS);
    return () => { clearTimeout(timer); };
  }, [copied]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      announce('Copied');
    } catch {
      announce('Copy failed. Select the text and copy it manually.');
    }
  };

  return (
    <IconButton
      label={label}
      icon={copied ? Check : Copy}
      size="sm"
      onClick={() => { void onCopy(); }}
    />
  );
}
