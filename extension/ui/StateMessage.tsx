import type { PropsWithChildren } from 'react';
import { CircleAlert, FolderOpen, LoaderCircle } from 'lucide-react';

export function StateMessage({
  kind,
  title,
  children,
}: PropsWithChildren<{
  kind: 'empty' | 'error' | 'loading';
  title: string;
}>) {
  const Icon = kind === 'error' ? CircleAlert : kind === 'loading' ? LoaderCircle : FolderOpen;
  return (
    <div className={`state ${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-busy={kind === 'loading'}>
      <Icon aria-hidden="true" />
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
