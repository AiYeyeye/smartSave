import { z } from 'zod';
import { siteRuleSchema, type SiteRule, siteHost } from '../domain/site-rules';
import type { IdentityStorage } from '../background/installation-identity';
const envelope = z
  .strictObject({ version: z.literal(1), rules: z.array(siteRuleSchema) })
  .superRefine((value, context) => {
    const hosts = new Set<string>();
    for (const rule of value.rules) {
      if (siteHost(`https://${rule.host}/`) !== rule.host || hosts.has(rule.host))
        context.addIssue({ code: 'custom', message: 'invalid-host' });
      hosts.add(rule.host);
    }
  });
export class SiteRulesStore {
  subscribe(listener: () => void) {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && Object.hasOwn(changes, 'siteRules')) listener();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }
  constructor(
    private readonly storage: IdentityStorage,
    private readonly lock: <T>(run: () => Promise<T>) => Promise<T> = run =>
      navigator.locks.request('zhilan-site-rules', run),
  ) {}
  async load(): Promise<SiteRule[]> {
    await this.storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const data = await this.storage.get('siteRules');
    return envelope.parse(data.siteRules ?? { version: 1, rules: [] }).rules;
  }
  async set(rule: SiteRule) {
    await this.lock(async () => {
      const rules = (await this.load()).filter(r => r.host !== rule.host);
      await this.storage.set({ siteRules: envelope.parse({ version: 1, rules: [...rules, rule] }) });
    });
  }
  async remove(host: string) {
    await this.lock(async () => {
      await this.storage.set({ siteRules: { version: 1, rules: (await this.load()).filter(r => r.host !== host) } });
    });
  }
}
