import { z } from 'zod';
import { modelAdapterSchema, type ModelAdapter } from './model-route';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const tokenCountsSchema = z.strictObject({
  input: count.optional(),
  output: count.optional(),
  total: count.optional(),
});
export type TokenCounts = z.infer<typeof tokenCountsSchema>;
export const tokenPurposeSchema = z.enum([
  'rename',
  'preference-summary',
  'save',
  'search',
  'search-expand',
  'history-query',
  'history-rank',
  'organize',
  'import-map',
  'import-classify',
  'connection-test',
]);
export type TokenPurpose = z.infer<typeof tokenPurposeSchema>;
export const tokenUsageRecordSchema = z.strictObject({
  id: z.string().min(1).max(100),
  at: count,
  adapter: modelAdapterSchema,
  model: z.string().min(1).max(512),
  purpose: tokenPurposeSchema,
  counts: tokenCountsSchema,
  /** The full wire response was read, independently of proposal/schema validity. */
  complete: z.boolean(),
});
export type TokenUsageRecord = z.infer<typeof tokenUsageRecordSchema>;

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const sum = (...values: (number | undefined)[]): number | undefined => {
  if (values.some(value => value === undefined)) return undefined;
  return integer(values.reduce<number>((total, value) => total + value!, 0));
};

/** Accumulate snapshots, never add cumulative stream frames together. Only provider counters enter here. */
export function tokenUsageAccumulator(adapter: ModelAdapter) {
  const fields: Record<string, number> = {};
  return {
    push(raw: unknown) {
      const envelope = obj(raw);
      const usage =
        adapter === 'google-generative-ai'
          ? obj(envelope.usageMetadata)
          : adapter === 'anthropic'
            ? obj(envelope.type === 'message_start' ? obj(envelope.message).usage : envelope.usage)
            : adapter === 'openai-responses'
              ? obj(obj(envelope.response).usage ?? envelope.usage)
              : adapter === 'ollama'
                ? envelope
                : obj(envelope.usage);
      // A later cumulative snapshot may omit total. Do not retain a stale earlier total
      // after its input/output counters changed; derive only from the reported components.
      const totalKey = adapter === 'google-generative-ai' ? 'totalTokenCount' : 'total_tokens';
      const componentKeys =
        adapter === 'google-generative-ai'
          ? ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount']
          : ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens'];
      if (integer(usage[totalKey]) === undefined && componentKeys.some(key => integer(usage[key]) !== undefined))
        delete fields[totalKey];
      for (const [key, value] of Object.entries(usage)) {
        const n = integer(value);
        if (n !== undefined) fields[key] = n;
      }
    },
    snapshot(): TokenCounts {
      let input: number | undefined;
      let output: number | undefined;
      let total: number | undefined;
      if (adapter === 'anthropic') {
        input =
          fields.input_tokens === undefined
            ? undefined
            : sum(fields.input_tokens, fields.cache_creation_input_tokens ?? 0, fields.cache_read_input_tokens ?? 0);
        output = fields.output_tokens;
      } else if (adapter === 'google-generative-ai') {
        input =
          fields.promptTokenCount === undefined
            ? undefined
            : sum(fields.promptTokenCount, fields.toolUsePromptTokenCount ?? 0);
        output =
          fields.candidatesTokenCount === undefined
            ? undefined
            : sum(fields.candidatesTokenCount, fields.thoughtsTokenCount ?? 0);
        total = fields.totalTokenCount;
      } else if (adapter === 'ollama') {
        input = fields.prompt_eval_count;
        output = fields.eval_count;
      } else if (adapter === 'openai-responses') {
        input = fields.input_tokens;
        output = fields.output_tokens;
        total = fields.total_tokens;
      } else {
        input = fields.prompt_tokens;
        output = fields.completion_tokens;
        total = fields.total_tokens;
      }
      total ??= sum(input, output);
      return {
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        ...(total === undefined ? {} : { total }),
      };
    },
  };
}

export const usageSummarySchema = z.strictObject({
  requests: count,
  missing: count,
  partial: count,
  input: count,
  output: count,
  total: count,
  inputKnown: count,
  outputKnown: count,
  totalKnown: count,
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export const emptyUsageSummary = (): UsageSummary => ({
  requests: 0,
  missing: 0,
  partial: 0,
  input: 0,
  output: 0,
  total: 0,
  inputKnown: 0,
  outputKnown: 0,
  totalKnown: 0,
});
export function addUsageSummaries(a: UsageSummary, b: UsageSummary): UsageSummary {
  const result = { ...a };
  for (const key of Object.keys(a) as (keyof UsageSummary)[]) result[key] += b[key];
  return result;
}
export function summarizeUsageRecord(record: TokenUsageRecord): UsageSummary {
  const out = emptyUsageSummary();
  out.requests = 1;
  const known = Object.keys(record.counts).length > 0;
  out.missing = known ? 0 : 1;
  out.partial = known && (!record.complete || Object.keys(record.counts).length < 3) ? 1 : 0;
  for (const key of ['input', 'output', 'total'] as const) {
    const value = record.counts[key];
    if (value !== undefined) {
      out[key] = value;
      out[`${key}Known`] = 1;
    }
  }
  return out;
}

/** Local calendar day, avoiding UTC midnight surprises in the dashboard. */
export function usageDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
