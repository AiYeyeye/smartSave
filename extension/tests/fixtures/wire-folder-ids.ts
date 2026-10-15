/** Synthetic providers read the same quoted catalog that the real model receives. */
export function wireFolderIds(payload: { folderTree: string }): string[] {
  return payload.folderTree
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const quotedId = line.trimStart().match(/^("(?:[^"\\]|\\.)*") /)?.[1];
      if (!quotedId) throw Error('invalid-synthetic-folder-catalog');
      return JSON.parse(quotedId) as string;
    });
}
