/** Harbor embeds its complete private agent config (including lease-local proxy credentials) in TrialResult. */
export function portableRemoteTrial(trial: Record<string, unknown>): Record<string, unknown> {
  const { config: _privateConfig, ...result } = trial;
  return structuredClone(result);
}
