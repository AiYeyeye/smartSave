import { z } from 'zod';
import { nodeRefSchema, treeStateSchema } from './node-reference';
import { siteRuleSchema } from './site-rules';
import { mutationResultSchema } from '../schemas/messages';

const id = z.string().min(1).max(256);
export const correctionMessageSchema = z.discriminatedUnion('action', [
  z.strictObject({ type: z.literal('nativeSaveCorrection'), action: z.literal('begin'), receiptId: id }),
  z.strictObject({ type: z.literal('nativeSaveCorrection'), action: z.literal('move'), token: id, targetId: id }),
  z.strictObject({
    type: z.literal('nativeSaveCorrection'),
    action: z.literal('rule'),
    token: id,
    includeSubdomains: z.boolean(),
    confirmed: z.literal(true),
  }),
  z.strictObject({ type: z.literal('nativeSaveCorrection'), action: z.literal('close'), token: id }),
]);
export type CorrectionMessage = z.infer<typeof correctionMessageSchema>;
export const correctionResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    token: id,
    bookmarkId: id,
    tree: treeStateSchema.options[2].shape.snapshot,
  }),
  z.strictObject({
    status: z.literal('moved'),
    requestId: id,
    host: z.string(),
    target: nodeRefSchema,
    targetTitle: z.string(),
    previousRule: siteRuleSchema.nullable(),
  }),
  z.strictObject({ status: z.literal('result'), result: mutationResultSchema }),
  z.strictObject({ status: z.literal('rule-saved') }),
  z.strictObject({ status: z.literal('closed') }),
  z.strictObject({ status: z.literal('error'), reason: z.string() }),
]);
export type CorrectionResponse = z.infer<typeof correctionResponseSchema>;

export function correctionError(reason: string): string {
  switch (reason) {
    case 'legacy-receipt':
      return '这条旧记录缺少安装身份，请从书签目录手动移动。';
    case 'same-folder':
      return '已在此目录，没有移动；如需设置网站规则，请打开隐私与规则。';
    case 'rule-changed':
      return '此网站规则已在别处修改，未覆盖。请到隐私与规则核对。';
    case 'stale-correction':
      return '书签、目录或记录已变化，请关闭后重新核对。';
    case 'session-expired':
      return '纠正确认已失效，请重新打开。已提交的移动请从恢复记录核对。';
    case 'correction-unsettled':
      return '上次纠正尚未核实，请到恢复记录核对，暂不重复移动。';
    case 'transport-unavailable':
      return '响应未能确认，请查看恢复记录；不会自动重复移动。';
    default:
      return '操作未完成。若已移动，规则仍可单独重试；请核对恢复记录。';
  }
}
