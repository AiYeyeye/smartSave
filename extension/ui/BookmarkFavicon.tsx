import { useEffect, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { bookmarkFaviconUrl } from '../domain/bookmark-favicon';

export function BookmarkFavicon({ url }: { url?: string }) {
  const src = bookmarkFaviconUrl(url);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <Bookmark aria-hidden="true" />;
  return <img className="bookmark-favicon" alt="" width={16} height={16} src={src} onError={() => setFailed(true)} />;
}
