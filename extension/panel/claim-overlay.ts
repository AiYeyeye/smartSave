/** A rejected or silent bootstrap must never proceed to bookmark/service connections. */
export async function claimOverlay(
  token: string,
  send: (message: { type: 'zhilan-overlay-claim'; token: string }) => Promise<unknown> = message =>
    chrome.runtime.sendMessage(message),
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      send({ type: 'zhilan-overlay-claim', token }),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), 10_000);
      }),
    ]);
    return !!reply && typeof reply === 'object' && 'ok' in reply && reply.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
