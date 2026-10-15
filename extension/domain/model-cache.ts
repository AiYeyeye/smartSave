import type { ModelConfig } from './model-route';

/** Native Anthropic caching is opt-in at a stable prefix; unknown proxies keep their existing shape. */
export function anthropicPromptContent(config: ModelConfig, payload: string) {
  try {
    if (new URL(config.baseUrl).origin !== 'https://api.anthropic.com') return payload;
    const value = JSON.parse(payload);
    if (!value || typeof value.folderTree !== 'string' || !value.folderTree || !Array.isArray(value.items))
      return payload;
    const { query, items, fields, snippet, ...shared } = value;
    const variable = {
      ...(query === undefined ? {} : { query }),
      items,
      ...(fields === undefined ? {} : { fields }),
      ...(snippet === undefined ? {} : { snippet }),
    };
    // Concatenation is the exact compact JSON. A block boundary adds no bookmark data to the cache prefix.
    return [
      {
        type: 'text' as const,
        text: JSON.stringify(shared).slice(0, -1),
        cache_control: { type: 'ephemeral' as const },
      },
      { type: 'text' as const, text: `,${JSON.stringify(variable).slice(1)}` },
    ];
  } catch {
    return payload;
  }
}
