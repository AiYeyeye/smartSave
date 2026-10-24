import {
  bookmarkCheckResponseSchema,
  CHECK_ORIGINS,
  type BookmarkCheckMessage,
  type BookmarkCheckState,
} from '../domain/bookmark-check';

export type CheckClient = (message: BookmarkCheckMessage) => Promise<BookmarkCheckState>;
export const sendBookmarkCheck: CheckClient = message =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('check-unavailable')), 15_000);
    void Promise.resolve()
      .then(() => chrome.runtime.sendMessage(message))
      .then(raw => {
        const response = bookmarkCheckResponseSchema.safeParse(raw);
        if (!response.success) throw Error('check-unavailable');
        if (response.data.status === 'error') throw Error(response.data.reason);
        resolve(response.data.state);
      })
      .catch(error => reject(error))
      .finally(() => clearTimeout(timer));
  });

/** Call directly in a click/change handler, before any asynchronous work loses the user gesture. */
export function requestCheckPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: CHECK_ORIGINS });
}
