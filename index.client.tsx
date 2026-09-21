import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Image, View } from "react-native";
import { PROVIDER_LOGOS } from "./client/logos";
import { createLimitsPopover } from "./client/limits-popover";
import {
  createUsageStore,
  findProviderUsage,
  pillLabel,
  pillTone,
  pillWindows,
  baseProviderKey,
  toneFor,
  usedPercent,
  type UsageStore,
  type UsageTone,
} from "./client/usage-store";

const PILL_ID = "limits";

/** Brand marks stay in brand colour; Codex uses the foreground like the composer chip does. */
const BRAND_COLORS: Record<string, string> = { claude: "#D97757" };

/**
 * The provider's logo, tinted by the worst window's tone. Providers without a bundled mark fall
 * back to two stacked mini bars (session on top, weekly below).
 */
function createLimitsIcon(store: UsageStore, agentProvider: () => string | null) {
  return function LimitsIcon({ size, theme }: PluginButtonIconProps) {
    const provider = agentProvider();
    const usage = provider ? findProviderUsage(store.getState(), provider) : null;
    const wins = usage && usage.status === "available" ? pillWindows(usage) : [];
    const toneColor = (tone: UsageTone) =>
      tone === "danger"
        ? theme.colors.statusDanger
        : tone === "warning"
          ? theme.colors.statusWarning
          : theme.colors.statusSuccess;
    const key = provider ? baseProviderKey(store.getState(), provider) : "";
    const logo = key ? PROVIDER_LOGOS[key] : undefined;
    if (logo) {
      const brand = BRAND_COLORS[key] ?? theme.colors.foreground;
      const tone = wins.length > 0 ? pillTone(usage) : "ok";
      const dot = Math.max(5, Math.round(size * 0.4));
      return (
        <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
          <Image source={{ uri: logo }} style={{ width: size, height: size, tintColor: brand }} resizeMode="contain" />
          {tone !== "ok" ? (
            <View
              style={{
                position: "absolute",
                right: -1,
                top: -1,
                width: dot,
                height: dot,
                borderRadius: dot / 2,
                backgroundColor: toneColor(tone),
                borderWidth: 1,
                borderColor: theme.colors.surface1,
              }}
            />
          ) : null}
        </View>
      );
    }
    const rows = [0, 1].map((index) => {
      const win = wins[index];
      const pct = win ? usedPercent(win) : null;
      return { pct: pct ?? 0, tone: win ? toneFor(win, pct) : ("ok" as UsageTone), known: Boolean(win) };
    });
    const barHeight = 3;
    const gap = 3;
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: size, height: barHeight * 2 + gap, gap }}>
          {rows.map((row, index) => (
            <View
              key={index}
              style={{ width: size, height: barHeight, borderRadius: barHeight / 2, backgroundColor: theme.colors.border, overflow: "hidden" }}
            >
              <View
                style={{
                  width: `${Math.max(row.known ? 6 : 0, row.pct)}%`,
                  height: barHeight,
                  borderRadius: barHeight / 2,
                  backgroundColor: toneColor(row.tone),
                }}
              />
            </View>
          ))}
        </View>
      </View>
    );
  };
}

export default function contribute(client: PluginClientContext) {
  const store = createUsageStore(client.paseo);

  type Tracked = { registration: PluginButtonRegistration; provider: string; workspaceId: string };
  const pills = new Map<string, Tracked>();
  const providers = new Map<string, string>();
  let stopped = false;

  const describe = (agentId: string) => {
    const provider = providers.get(agentId) ?? null;
    const usage = provider ? findProviderUsage(store.getState(), provider) : null;
    return { label: pillLabel(usage, store.getState()), usage };
  };

  const register = (agent: { id: string; provider: string; workspaceId?: string | null }) => {
    if (stopped || !agent.workspaceId) return;
    const existing = pills.get(agent.id);
    providers.set(agent.id, agent.provider);
    if (existing && existing.workspaceId === agent.workspaceId) {
      if (existing.provider !== agent.provider) {
        existing.provider = agent.provider;
        existing.registration.update({ label: describe(agent.id).label });
      }
      return;
    }
    existing?.registration.remove();
    const agentId = agent.id;
    const providerOf = () => providers.get(agentId) ?? null;
    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId: agent.workspaceId,
      agentId,
      button: {
        title: "Subscription limits",
        icon: createLimitsIcon(store, providerOf),
        label: describe(agentId).label,
        behavior: { kind: "popover", Content: createLimitsPopover(store, providerOf) },
      },
    });
    pills.set(agentId, { registration, provider: agent.provider, workspaceId: agent.workspaceId });
  };

  const unregister = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
    providers.delete(agentId);
  };

  // Re-label every pill when usage changes. The icon re-reads the store on its next render.
  const unsubscribeStore = store.subscribe(() => {
    for (const [agentId, tracked] of pills) {
      tracked.registration.update({ label: describe(agentId).label });
    }
  });

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") unregister(update.agentId);
    else register(update.agent);
  });

  void client.paseo.agents
    .list({ filter: { includeArchived: false } })
    .then(({ entries }) => {
      for (const { agent } of entries) register(agent);
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[paseo-limits] agent list failed", error);
    });

  store.start();

  return () => {
    stopped = true;
    unsubscribeStore();
    unsubscribeAgents();
    store.stop();
    for (const tracked of pills.values()) tracked.registration.remove();
    pills.clear();
    providers.clear();
  };
}
