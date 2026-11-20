import { BULK_LABEL } from "./rtc-bulk";

/** getStats is optional diagnostic work. Concurrent file tasks share a single outstanding poll. */
export function cachedRtcStats(read: () => Promise<Record<string, unknown> | undefined>) {
  let stats: Record<string, unknown> | undefined;
  let started = -Infinity, completed = 0, pending = false;
  return () => {
    const now = performance.now();
    if (!pending && now - started >= 1000) {
      pending = true;
      started = now;
      void read().then(value => { stats = value; completed = performance.now(); })
        .catch(() => { stats = undefined; }).finally(() => { pending = false; });
    }
    return stats && { ...stats, rtcStatsAgeMs: Math.round(now - completed) };
  };
}

export function rtcCounters(report: RTCStatsReport, channelId?: number | null) {
  const entries = [...report.values()];
  const transport = entries.find(s => s.type === "transport" && s.selectedCandidatePairId);
  const nominated = entries.filter(s => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
  const pair = transport ? report.get(transport.selectedCandidatePairId) : nominated.length === 1 ? nominated[0] : undefined;
  const channels = entries.filter(s => s.type === "data-channel" && (s.label === BULK_LABEL ||
    (channelId == null ? s.label === "hummingbird-v2" : s.dataChannelIdentifier === channelId)));
  const sum = (field: string) => channels.length && channels.every(c => typeof c[field] === "number")
    ? channels.reduce((total, c) => total + c[field], 0) : undefined;
  return {
    rtcRttMs: pair?.currentRoundTripTime == null ? undefined : Math.round(pair.currentRoundTripTime * 1000),
    localCandidateType: pair && report.get(pair.localCandidateId)?.candidateType,
    remoteCandidateType: pair && report.get(pair.remoteCandidateId)?.candidateType,
    rtcSentBytes: sum("bytesSent"), rtcReceivedBytes: sum("bytesReceived"),
    rtcSentMessages: sum("messagesSent"), rtcReceivedMessages: sum("messagesReceived"),
  };
}
