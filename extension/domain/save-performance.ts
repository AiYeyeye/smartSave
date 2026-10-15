export type ModelTiming = {
  ms: number;
  attempts: number;
  streaming?: boolean;
  /** Full response body received, measured from transport start. */
  responseMs?: number;
  /** Actual answer text only; headers/thinking/comments do not count. SSE only. */
  firstTokenMs?: number;
  generationMs?: number;
  validationMs?: number;
};
export type SaveTiming = {
  /** From the observed native creation event; includes settling and initial reads. */
  totalMs: number;
  prepareMs: number;
  model?: ModelTiming;
  applyMs?: number;
};
type Sample = { status: string; model?: string; ms?: number; timing?: SaveTiming };
const valid = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
function distribution(values: (number | undefined)[]) {
  const sorted = values.filter(valid).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length
    ? {
        count: sorted.length,
        median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
        p90: sorted[Math.ceil(sorted.length * 0.9) - 1]!,
      }
    : undefined;
}

/** Aggregate only completed saves, keeping failures out of speed percentiles. No titles/URLs. */
export function summarizeSaveTimings(receipts: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const receipt of receipts) {
    if (!receipt.model || !['moved', 'kept', 'undone', 'failed'].includes(receipt.status)) continue;
    const list = groups.get(receipt.model) ?? [];
    list.push(receipt);
    groups.set(receipt.model, list);
  }
  return [...groups].map(([model, samples]) => {
    const completed = samples.filter(s => s.status !== 'failed');
    return {
      model,
      completed: completed.length,
      failed: samples.length - completed.length,
      total: distribution(completed.map(s => s.timing?.totalMs)),
      legacy: distribution(completed.filter(s => !s.timing).map(s => s.ms)),
      firstToken: distribution(completed.map(s => s.timing?.model?.firstTokenMs)),
      generation: distribution(completed.map(s => s.timing?.model?.generationMs)),
      validationApply: distribution(
        completed.map(s =>
          s.timing?.model?.validationMs === undefined || s.timing.applyMs === undefined
            ? undefined
            : s.timing.model.validationMs + s.timing.applyMs,
        ),
      ),
    };
  });
}
