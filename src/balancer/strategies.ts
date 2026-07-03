import type { AccountState, Strategy, StrategyName } from "./types";

// Pure selection functions. Input is the already-filtered available pool.
// Never mutate inputs.

function minBy<T>(items: T[], key: (t: T) => number): T | null {
  const first = items[0];
  if (first === undefined) return null;
  let best = first;
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const k = key(item);
    if (k < bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

export const STRATEGIES: Record<StrategyName, Strategy> = {
  priority: {
    name: "priority",
    description: "Lowest priority number first; ties broken by fewest requests. Predictable ordered failover.",
    pick: (a) => minBy(a, (x) => x.priority * 1e9 + x.requestCount),
  },

  round_robin: {
    name: "round_robin",
    description: "Least-recently-used account. Spreads load evenly over time.",
    pick: (a) => minBy(a, (x) => x.lastUsed ?? 0),
  },

  least_used: {
    name: "least_used",
    description: "Fewest requests this session. Evens out cumulative usage.",
    pick: (a) => minBy(a, (x) => x.sessionRequestCount),
  },

  weighted_random: {
    name: "weighted_random",
    description: "Random, weighted by remaining rate-limit budget. Avoids thundering herd.",
    pick: (a, _now) => {
      const weights = a.map((x) => Math.max(1, x.rateLimitRemaining ?? 100));
      const total = weights.reduce((s, w) => s + w, 0);
      let r = Math.random() * total;
      for (let i = 0; i < a.length; i++) {
        const account = a[i];
        const weight = weights[i] ?? 0;
        if (account === undefined) continue;
        r -= weight;
        if (r <= 0) return account;
      }
      return a[a.length - 1] ?? null;
    },
  },

  session_reset_drain: {
    name: "session_reset_drain",
    description: "Prefer the account whose usage window resets soonest — drains the closest-to-fresh account first.",
    pick: (a) => minBy(a, (x) => x.rateLimitReset ?? Number.MAX_SAFE_INTEGER),
  },
};

export function selectAccount(
  strategy: StrategyName,
  available: AccountState[],
  now: number,
): AccountState | null {
  const s = STRATEGIES[strategy] ?? STRATEGIES.priority;
  return s.pick(available, now);
}

export function isStrategyName(value: string): value is StrategyName {
  return value in STRATEGIES;
}
