import { expect, it } from 'vitest';
import { extractJsonObject, normalizeModelJson } from '../adapters/model-transport';
import { parseModelOutput } from '../schemas/model-output';

const context = {
  task: 'save',
  items: [{ id: '2506', title: '百度一下' }],
  folders: [{ id: '2348' }, { id: '17' }],
};

it('extracts JSON from fenced, prefixed and <think>-wrapped replies', () => {
  const body = '{"assignments":[{"itemId":"2506","folderId":"17"}],"newFolders":[]}';
  for (const reply of [
    body,
    '```json\n' + body + '\n```',
    '好的，结果如下：\n' + body,
    '<think>先看目录…</think>\n' + body,
  ])
    expect(extractJsonObject(reply)).toEqual(JSON.parse(body));
  expect(() => extractJsonObject('抱歉，我无法完成')).toThrow('json');
});

it('accepts numeric ids, commentary keys and a missing empty newFolders, but still rejects smuggled fields', () => {
  const sloppy = { assignments: [{ itemId: 2506, folderId: 17, reason: '搜索引擎' }], confidence: 0.9 };
  expect(parseModelOutput(normalizeModelJson(sloppy, 'save'), context)).toEqual({
    assignments: [{ itemId: '2506', folderId: '17' }],
    newFolders: [],
  });
  const smuggled = { assignments: [{ itemId: '2506', folderId: '17', url: 'https://evil.test' }], newFolders: [] };
  expect(() => parseModelOutput(normalizeModelJson(smuggled, 'save'), context)).toThrow('invalid-output');
  expect(() =>
    parseModelOutput(normalizeModelJson({ rankedIds: [2506], url: 'x' }, 'search'), { ...context, task: 'search' }),
  ).toThrow('invalid-output');
});
