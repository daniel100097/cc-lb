import type { AccountState, Strategy, StrategyName } from "./types";

// Pure selection functions. Input is the already-filtered available pool.
// Never mutate inputs.

function minBy<T>(items: T[], compare: (a: T, b: T) => number): T | null {
  const first = items[0];
  if (first === undefined) return null;
  let best = first;
  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    if (compare(item, best) < 0) {
      best = item;
    }
  }
  return best;
}

function compareNumber(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareId(a: AccountState, b: AccountState): number {
  return a.id.localeCompare(b.id);
}

export const STRATEGIES: Record<StrategyName, Strategy> = {
  priority: {
    name: "priority",
    description: "Lowest priority number first; ties broken by fewest requests. Predictable ordered failover.",
    pick: (a) =>
      minBy(a, (x, y) =>
        compareNumber(x.priority, y.priority) ||
        compareNumber(x.requestCount, y.requestCount) ||
        compareId(x, y),
      ),
  },

  round_robin: {
    name: "round_robin",
    description: "Least-recently-used account. Spreads load evenly over time.",
    pick: (a) => minBy(a, (x, y) => compareNumber(x.lastUsed ?? 0, y.lastUsed ?? 0) || compareId(x, y)),
  },

  least_used: {
    name: "least_used",
    description: "Fewest requests this session. Evens out cumulative usage.",
    pick: (a) =>
      minBy(a, (x, y) =>
        compareNumber(x.sessionRequestCount, y.sessionRequestCount) ||
        compareNumber(x.requestCount, y.requestCount) ||
        compareId(x, y),
      ),
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
    pick: (a) =>
      minBy(a, (x, y) =>
        compareNumber(x.rateLimitReset ?? Number.MAX_SAFE_INTEGER, y.rateLimitReset ?? Number.MAX_SAFE_INTEGER) ||
        compareId(x, y),
      ),
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
