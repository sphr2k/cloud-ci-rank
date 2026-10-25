/** AMI mappings shipped in buildkite/terraform-buildkite-elastic-ci-stack-for-aws v1.4.0.
 * A mapping is not a guarantee the public AMI is still accessible to this account.
 * Notably, eu-south-2 and eu-central-2 do NOT have mapping entries.
 */
export const BUILDKITE_AMI_REGIONS = [
  'eu-central-1', 'eu-north-1', 'eu-south-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3',
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
] as const;
export const BUILDKITE_AMI_REGION_SET: ReadonlySet<string> = new Set(BUILDKITE_AMI_REGIONS);
export type RegionFilter = string;
export function countryFromRegionLabel(label:string):string|null {
  return /\(([A-Z]{2})\)\s*$/.exec(label)?.[1]??null;
}
