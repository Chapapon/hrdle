import type { PiUsageSummary, PiUsageWindow } from '../../../shared/types';
import { parsePiRecord, type PiUsage, PiSessionStore } from './pi';

/**
 * pi token consumption for the dashboard, from the usage every assistant
 * message carries. pi exposes no rate-limit windows, so totals are what can
 * be shown; and the cost is pi's own per-turn figure (it prices each turn from
 * its model list), so `costUsd` appears only when a turn in the window carried
 * one. A free or local model records 0, which is a figure and not an absence.
 */
export class PiUsageService {
  private cache: { timestamp: number; data: PiUsageSummary | null } | null = null;
  private static readonly CACHE_TTL = 30_000;
  private static readonly WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly WINDOW_24H_MS = 24 * 60 * 60 * 1000;

  constructor(private readonly store = new PiSessionStore()) {}

  /** Never rejects: an unreadable store is "no summary", not a failed dashboard. */
  async getUsageSummary(): Promise<PiUsageSummary | null> {
    if (this.cache && Date.now() - this.cache.timestamp < PiUsageService.CACHE_TTL) {
      return this.cache.data;
    }
    let data: PiUsageSummary | null;
    try {
      data = await this.build();
    } catch (error) {
      console.error('pi usage: failed to build summary', error);
      data = null;
    }
    this.cache = { timestamp: Date.now(), data };
    return data;
  }

  private async build(): Promise<PiUsageSummary | null> {
    const now = Date.now();
    const cutoff7d = now - PiUsageService.WINDOW_7D_MS;
    const cutoff24h = now - PiUsageService.WINDOW_24H_MS;
    const sessions = (await this.store.listSessions()).filter(
      (s) => new Date(s.updatedAt).getTime() >= cutoff7d,
    );
    if (sessions.length === 0) return null;

    const last7d = emptyWindow();
    const last24h = emptyWindow();
    const modelTotals = new Map<string, { totalTokens: number; costUsd?: number }>();
    let sessions7d = 0;
    let lastTurnAt = 0;

    for (const session of sessions) {
      let text: string;
      try {
        text = await this.store.readTranscript(session);
      } catch {
        continue;
      }
      let counted = false;
      for (const line of text.split('\n')) {
        const record = parsePiRecord(line);
        const message = record?.message;
        if (record?.type !== 'message' || message?.role !== 'assistant' || !message.usage) continue;
        const at = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
        if (!Number.isFinite(at) || at < cutoff7d) continue;
        const cost = typeof message.usage.cost?.total === 'number' ? message.usage.cost.total : undefined;
        addToWindow(last7d, message.usage, cost);
        if (at >= cutoff24h) addToWindow(last24h, message.usage, cost);
        counted = true;
        if (at > lastTurnAt) lastTurnAt = at;
        if (typeof message.model === 'string' && message.model) {
          const total = modelTotals.get(message.model) ?? { totalTokens: 0 };
          total.totalTokens += totalTokensOf(message.usage);
          if (cost !== undefined) total.costUsd = (total.costUsd ?? 0) + cost;
          modelTotals.set(message.model, total);
        }
      }
      if (counted) sessions7d++;
    }
    if (last7d.turns === 0) return null;

    return {
      last24h,
      last7d,
      models: Array.from(modelTotals.entries())
        .map(([model, total]) => ({ model, totalTokens: total.totalTokens, costUsd: total.costUsd }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      sessions7d,
      lastTurnAt: lastTurnAt > 0 ? new Date(lastTurnAt).toISOString() : undefined,
    };
  }
}

function emptyWindow(): PiUsageWindow {
  return { turns: 0, totalTokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

/** Input, cache reads and output; reasoning is inside output already. */
export function totalTokensOf(usage: PiUsage): number {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
}

function addToWindow(window: PiUsageWindow, usage: PiUsage, cost?: number): void {
  window.turns++;
  window.totalTokens += totalTokensOf(usage);
  window.inputTokens += (usage.input ?? 0) + (usage.cacheWrite ?? 0);
  window.cacheReadTokens += usage.cacheRead ?? 0;
  window.outputTokens += usage.output ?? 0;
  window.reasoningTokens += usage.reasoning ?? 0;
  if (cost !== undefined) window.costUsd = (window.costUsd ?? 0) + cost;
}
