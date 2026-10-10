import { Plus } from 'lucide-react';

export function Avatar({
  letter,
  avatarClass,
  size = 'md',
  plus,
}: {
  letter: string;
  avatarClass: string;
  size?: 'sm' | 'md' | 'lg';
  plus?: boolean;
}) {
  const sizeClass = size === 'lg' ? ' lg' : size === 'sm' ? ' sm' : '';
  if (plus || avatarClass === 'plus') {
    return (
      <span className={`ai-svc-avatar plus${sizeClass}`} aria-hidden="true">
        <Plus aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={`ai-svc-avatar ${avatarClass}${sizeClass}`} aria-hidden="true">
      {letter}
    </span>
  );
}
