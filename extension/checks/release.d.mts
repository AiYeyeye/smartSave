export interface InventoryEntry { path: string; bytes: number; sha256: string }
export interface ManualRequirement { id: string; status: string; evidence: string | null; blocking: boolean }
export interface ReleaseResult {
  sourceErrors: string[];
  compatibilityBlockers: string[];
  manualRequirements: ManualRequirement[];
  format: string;
  version?: string;
  sourceIdentity: string;
  sourceInventoryHash: string;
  artifactInventoryHash: string;
  environment: { node: string; platform: string; arch: string };
  sourceFiles: InventoryEntry[];
  artifacts: InventoryEntry[];
  lockHash?: string;
  coverage: string;
}
export const approvedMinimumChromeVersion: number;
export const manualRequirements: ManualRequirement[];
export function checkRelease(directory: string): Promise<ReleaseResult>;
export function releaseGate(result: Pick<ReleaseResult, 'sourceErrors'> & Partial<Pick<ReleaseResult, 'compatibilityBlockers'>>): string[];
