import { z } from 'zod';
import { nodeRefSchema, type TreeSnapshot } from './node-reference';
import { validateUrl } from './preflight';
export const siteRuleSchema = z.strictObject({ host: z.string().min(1), includeSubdomains: z.boolean(), folder: nodeRefSchema.strict().refine(r => r.kind === 'folder') });
export type SiteRule = z.infer<typeof siteRuleSchema>;
export function siteHost(url: string) { validateUrl(url); return new URL(url).hostname; }
export function matchSiteRule(url: string, rules: SiteRule[]): SiteRule | undefined {
  const host = siteHost(url);
  return rules.filter(r => host === r.host || (r.includeSubdomains && host.endsWith(`.${r.host}`))).sort((a, b) => b.host.length - a.host.length)[0];
}
export function ruleFolder(rule: SiteRule, tree: TreeSnapshot) {
  return tree.nodes.find(n => n.ref.installationId === rule.folder.installationId && n.ref.nativeId === rule.folder.nativeId && n.ref.kind === 'folder' && n.childrenWritable);
}
