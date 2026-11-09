export function normalizeHarborResult(raw: Record<string, unknown>): Record<string, unknown> {
  const trials = Array.isArray(raw?.trial_results) ? raw.trial_results as Record<string, unknown>[] : [];
  const rewardValues = new Map<string, number[]>();
  const normalizedTrials = trials.map((trial) => {
    const verifier = (trial?.verifier_result || {}) as Record<string, unknown>;
    const rewards = (verifier.rewards || {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(rewards)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const values = rewardValues.get(name) || [];
      values.push(value);
      rewardValues.set(name, values);
    }
    return {
      task_name: trial?.task_name || null,
      trial_name: trial?.trial_name || null,
      status: trial?.exception_info ? "errored" : "completed",
      rewards,
      exception: trial?.exception_info || null,
    };
  });
  const rewards = Object.fromEntries([...rewardValues.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  }]));
  const rewardEntries = Object.entries(rewards);
  const primary = (rewards.reward as Record<string, unknown>) || rewardEntries[0]?.[1] || null;
  const stats = (raw?.stats || {}) as Record<string, unknown>;
  return {
    n_trials: raw?.n_total_trials ?? trials.length,
    n_completed: stats.n_completed_trials ?? normalizedTrials.filter((trial) => trial.status === "completed").length,
    n_errored: stats.n_errored_trials ?? normalizedTrials.filter((trial) => trial.status === "errored").length,
    n_cancelled: stats.n_cancelled_trials ?? 0,
    primary_reward: (primary as Record<string, unknown>)?.mean ?? null,
    rewards,
    trials: normalizedTrials,
  };
}
