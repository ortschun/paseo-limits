import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import {
  findProviderUsage,
  displayWindowLabel,
  formatAge,
  formatPlan,
  formatReset,
  pillWindows,
  toneFor,
  usagePacing,
  usedPercent,
  type ProviderUsage,
  type UsageStore,
  type UsageTone,
  type UsageWindow,
} from "./usage-store";

function toneColor(theme: PluginTheme, tone: UsageTone): string {
  if (tone === "danger") return theme.colors.statusDanger;
  if (tone === "warning") return theme.colors.statusWarning;
  return theme.colors.statusSuccess;
}

export function createLimitsPopover(store: UsageStore, agentProvider: () => string | null) {
  return function LimitsPopover(props: PluginButtonContentProps) {
    const { theme, layout } = props;
    const provider = agentProvider();
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
    const usage = provider ? findProviderUsage(state, provider) : null;

    useEffect(() => {
      void store.refresh();
    }, []);

    const styles = useMemo(
      () => ({
        root: {
          minWidth: layout.compact ? undefined : 320,
          padding: layout.compact ? 16 : 12,
          gap: 10,
          backgroundColor: theme.colors.surface1,
        },
        head: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "baseline" as const },
        name: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
        plan: { color: theme.colors.foregroundMuted, fontSize: 12 },
        muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
        foot: {
          flexDirection: "row" as const,
          justifyContent: "space-between" as const,
          alignItems: "center" as const,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          paddingTop: 8,
          marginTop: 2,
        },
        link: { color: theme.colors.accent, fontSize: 12 },
      }),
      [theme, layout.compact],
    );

    return (
      <View style={styles.root}>
        {usage ? (
          <>
            <View style={styles.head}>
              <Text style={styles.name}>{usage.displayName}</Text>
              <Text style={styles.plan}>{formatPlan(usage.planLabel) ?? usage.sourceLabel ?? ""}</Text>
            </View>
            {usage.status === "available" ? (
              <ProviderWindows usage={usage} theme={theme} />
            ) : (
              <Text style={styles.muted}>{usage.error ?? "Usage unavailable for this provider."}</Text>
            )}
          </>
        ) : (
          <Text style={styles.muted}>
            {state.error
              ? `Could not load limits: ${state.error}`
              : state.fetchedAt
                ? `No subscription limits reported for ${provider ?? "this provider"}.`
                : "Loading limits…"}
          </Text>
        )}
        <View style={styles.foot}>
          <Text style={styles.muted}>
            {state.loading ? "refreshing…" : formatAge(usage?.fetchedAt ?? state.fetchedAt)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh subscription limits"
            onPress={() => void store.refresh(true)}
          >
            <Text style={styles.link}>Refresh</Text>
          </Pressable>
        </View>
      </View>
    );
  };
}

function ProviderWindows({ usage, theme }: { usage: ProviderUsage; theme: PluginTheme }) {
  const primary = pillWindows(usage);
  const primaryIds = new Set(primary.map((win) => win.id));
  const rest = usage.windows.filter((win) => !primaryIds.has(win.id));
  return (
    <View style={{ gap: 8 }}>
      {[...primary, ...rest].map((win) => (
        <WindowRow key={win.id} win={win} theme={theme} />
      ))}
      {usage.balances?.filter(hasBalance).map((balance) => (
        <View key={balance.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{balance.label}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{formatBalance(balance)}</Text>
        </View>
      ))}
    </View>
  );
}

function WindowRow({ win, theme }: { win: UsageWindow; theme: PluginTheme }) {
  const pct = usedPercent(win);
  const tone = toneFor(win, pct);
  const color = toneColor(theme, tone);
  const reset = pct === null || pct > 0 ? formatReset(win.resetsAt) : null;
  const pacing = usagePacing(win);
  const pacingColor = pacing?.status === "ahead" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const pacingLabel =
    pacing?.status === "ahead"
      ? `${pacing.deltaPct}% ahead of pace`
      : pacing?.status === "behind"
        ? `${Math.abs(pacing.deltaPct)}% below pace`
        : pacing
          ? "On pace"
          : null;
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, width: 56 }} numberOfLines={1}>
          {displayWindowLabel(win)}
        </Text>
        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
          <View style={{ width: `${pct ?? 0}%`, height: "100%", borderRadius: 3, backgroundColor: color }} />
          {pacing ? (
            <View
              style={{
                position: "absolute",
                left: `${pacing.elapsedPct}%`,
                top: 0,
                width: 2,
                height: "100%",
                backgroundColor: theme.colors.foreground,
                opacity: 0.8,
                transform: [{ translateX: -1 }],
              }}
            />
          ) : null}
        </View>
        <Text style={{ color, fontSize: 12, width: 40, textAlign: "right", fontVariant: ["tabular-nums"] }}>
          {pct === null ? "–" : `${pct}%`}
        </Text>
      </View>
      {reset ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: 66 }}>{reset}</Text>
      ) : null}
      {pacing && pacingLabel ? (
        <Text style={{ color: pacingColor, fontSize: 11, marginLeft: 66 }}>
          {pacingLabel} · {pacing.usedPct}% used / {pacing.elapsedPct}% elapsed
        </Text>
      ) : null}
    </View>
  );
}

function formatBalance(balance: NonNullable<ProviderUsage["balances"]>[number]): string {
  const unit = balance.unit === "usd" ? "$" : "";
  const suffix = balance.unit === "usd" ? "" : ` ${balance.unit}`;
  const remaining = balance.remaining ?? (balance.limit != null && balance.used != null ? balance.limit - balance.used : null);
  if (remaining != null && balance.limit != null) return `${unit}${remaining}${suffix} of ${unit}${balance.limit}${suffix} left`;
  if (remaining != null) return `${unit}${remaining}${suffix} left`;
  if (balance.used != null) return `${unit}${balance.used}${suffix} used`;
  return "–";
}

function hasBalance(balance: NonNullable<ProviderUsage["balances"]>[number]): boolean {
  const remaining = balance.remaining ?? null;
  const limit = balance.limit ?? null;
  const used = balance.used ?? null;
  if (limit !== null && limit > 0) return true;
  if (remaining !== null && remaining > 0) return true;
  return used !== null && used > 0;
}
