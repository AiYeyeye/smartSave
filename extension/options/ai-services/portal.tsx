import { createPortal } from 'react-dom';
import type { PropsWithChildren } from 'react';

/**
 * Renders dialogs at the theme root so `position: fixed` is relative to the viewport, not to an
 * animated ancestor, while still inheriting the design tokens.
 */
export function DialogPortal({ children }: PropsWithChildren) {
  if (typeof document === 'undefined') return <>{children}</>;
  return createPortal(children, document.querySelector('.theme-root') ?? document.body);
}
