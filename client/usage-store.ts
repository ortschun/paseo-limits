import type { PluginClientContext } from "@getpaseo/plugin/client";

type PaseoApi = PluginClientContext["paseo"];

/** One provider entry from `paseo.providers.listUsage()`. */
export type ProviderUsage = Awaited<ReturnType<PaseoApi["providers"]["listUsage"]>>["providers"][number];
export type UsageWindow = ProviderUsage["windows"][number];
export type UsageTone = "ok" | "warning" | "danger";

export interface UsageState {
  providers: ProviderUsage[];
  /** Custom provider id → the builtin it `extends` (daemon config); usage is tracked per builtin. */
  bases: Record<string, string>;
  fetchedAt: string | null;
  error: string | null;
  loading: boolean;
}

const REFRESH_MS = 2 * 60 * 1000;
const MIN_REFETCH_MS = 15 * 1000;

/**
 * One shared poll of the daemon's usage service for every pill and popover. The store owns the
 * timer; the client entry stops it on cleanup.
 */
export function createUsageStore(paseo: PaseoApi) {
  let state: UsageState = { providers: [], bases: {}, fetchedAt: null, error: null, loading: false };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> | null = null;
  let lastFetch = 0;
  let stopped = false;

  const set = (patch: Partial<UsageState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const refresh = (force = false): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inflight) return inflight;
    if (!force && Date.now() - lastFetch < MIN_REFETCH_MS) return Promise.resolve();
    set({ loading: true });
    inflight = Promise.all([paseo.providers.listUsage(), readBases(paseo)])
      .then(([result, bases]) => {
        if (stopped) return;
        set({ providers: result.providers, bases, fetchedAt: result.fetchedAt, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message, loading: false });
      })
      .finally(() => {
        lastFetch = Date.now();
        inflight = null;
      });
    return inflight;
  };

  const start = () => {
    void refresh(true);
    timer = setInterval(() => void refresh(true), REFRESH_MS);
  };

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    listeners.clear();
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    start,
    stop,
  };
}

export type UsageStore = ReturnType<typeof createUsageStore>;

/** `extends` of every custom provider in daemon config. A failed read leaves the map empty. */
async function readBases(paseo: PaseoApi): Promise<Record<string, string>> {
  try {
    const { config } = await paseo.config.get();
    const bases: Record<string, string> = {};
    for (const [id, entry] of Object.entries(config.providers ?? {})) {
      const base = (entry as { extends?: unknown }).extends;
      if (typeof base === "string" && base) bases[id.toLowerCase()] = base.toLowerCase();
    }
    return bases;
  } catch {
    return {};
  }
}

/** `claude/opus` and `claude` both map to the usage entry `claude`. */
export function providerKey(agentProvider: string): string {
  return agentProvider.split("/")[0]?.toLowerCase() ?? agentProvider;
}

/** Follows `extends` to the builtin whose usage the daemon tracks: `claude-lead` → `claude`. */
export function baseProviderKey(state: UsageState, agentProvider: string): string {
  let key = providerKey(agentProvider);
  for (let hop = 0; hop < 8 && state.bases[key]; hop++) key = state.bases[key];
  return key;
}

export function findProviderUsage(state: UsageState, agentProvider: string): ProviderUsage | null {
  const key = baseProviderKey(state, agentProvider);
  return state.providers.find((entry) => entry.providerId.toLowerCase() === key) ?? null;
}

export function usedPercent(win: UsageWindow): number | null {
  if (typeof win.usedPct === "number") return clamp(win.usedPct);
  if (typeof win.remainingPct === "number") return clamp(100 - win.remainingPct);
  return null;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function toneFor(win: UsageWindow, pct: number | null): UsageTone {
  if (win.tone === "danger" || win.tone === "warning") return win.tone;
  if (pct === null) return "ok";
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warning";
  return "ok";
}

const TONE_RANK: Record<UsageTone, number> = { ok: 0, warning: 1, danger: 2 };

export function worstTone(tones: UsageTone[]): UsageTone {
  return tones.reduce<UsageTone>((worst, tone) => (TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst), "ok");
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * "5h" or "wk". Claude names its windows explicitly. Codex calls its primary window "Session"
 * and Paseo drops the window length, so an ambiguous window is classified by how far away its
 * reset is: a 5-hour window can never reset more than 5 hours out.
 */
export function shortWindowLabel(win: UsageWindow, now = Date.now()): string {
  const probe = `${win.id} ${win.label}`.toLowerCase();
  if (/five_hour|5h|5-hour|five hour/.test(probe)) return "5h";
  if (/week|seven|7d|7-day/.test(probe)) return "wk";
  if (/session|primary|secondary/.test(probe)) {
    const resetAt = win.resetsAt ? new Date(win.resetsAt).getTime() : Number.NaN;
    if (!Number.isNaN(resetAt) && resetAt - now > SIX_HOURS_MS) return "wk";
    return "5h";
  }
  const words = win.label.trim().split(/\s+/);
  return (words[0] ?? win.id).slice(0, 6).toLowerCase();
}

/** Popover row label: replaces Paseo's generic "Session" with what the window actually is. */
export function displayWindowLabel(win: UsageWindow): string {
  if (!/session|primary|secondary/i.test(`${win.id} ${win.label}`)) return win.label;
  return shortWindowLabel(win) === "wk" ? "Weekly" : "5-hour";
}

/** The two windows the pill shows: the session win first, then the weekly one. */
export function pillWindows(usage: ProviderUsage): UsageWindow[] {
  const ranked = [...usage.windows].sort((a, b) => rank(a) - rank(b));
  return ranked.slice(0, 2);
}

function rank(win: UsageWindow): number {
  const label = shortWindowLabel(win);
  if (label === "5h") return 0;
  if (label === "wk") return 1;
  return 2;
}

export function formatReset(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  const diffMs = at - now;
  if (diffMs <= 0) return "resets now";
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes - hours * 60;
    return rest > 0 ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
  }
  const date = new Date(at);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `resets ${weekday} ${time}`;
}

export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return "not fetched yet";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `updated ${minutes}m ago`;
}

/** Composer pill text. Paseo owns the pill chrome, so this is plain text only. */
export function pillLabel(usage: ProviderUsage | null, state: UsageState): string {
  if (!usage) return state.error ? "Limits unavailable" : state.fetchedAt ? "No limits" : "Limits…";
  if (usage.status !== "available") return "Limits unavailable";
  const parts = pillWindows(usage).map((win) => {
    const pct = usedPercent(win);
    return `${shortWindowLabel(win)} ${pct === null ? "–" : `${pct}%`}`;
  });
  if (parts.length === 0) return "Limits";
  return parts.join(" · ");
}

export function pillTone(usage: ProviderUsage | null): UsageTone {
  if (!usage || usage.status !== "available") return "ok";
  return worstTone(pillWindows(usage).map((win) => toneFor(win, usedPercent(win))));
}

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Education",
  max: "Max",
};

/** `prolite` → "Pro Lite"; unknown values get their words capitalised. */
export function formatPlan(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const key = plan.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (PLAN_LABELS[key]) return PLAN_LABELS[key];
  return plan
    .replace(/[_-]+/g, " ")
    .split(" ")
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}
