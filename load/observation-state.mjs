// Pure protocol helpers shared by the remote observer and local timing client.
export function compactCompletions(seen, rows) {
  const changes = [];
  for (const row of rows) {
    if (seen.get(row.id) === row.status) continue;
    seen.set(row.id, row.status);
    changes.push({ id: row.id, status: row.status });
  }
  return changes;
}

export function recordCompletions(state, rows, now) {
  for (const row of rows) {
    const entry = state.accepted.get(row.id);
    if (!entry) {
      state.earlyCompletions.set(row.id, { status: row.status, observed: now });
      continue;
    }
    if (!entry.observed) {
      entry.observed = Math.max(entry.ack, now);
      state.lastCompletion = Math.max(
        state.lastCompletion ?? 0,
        entry.observed,
      );
    }
    entry.status = row.status;
  }
}

export function recordAcceptance(state, id, entry) {
  state.accepted.set(id, entry);
  const early = state.earlyCompletions.get(id);
  if (!early) return;
  state.earlyCompletions.delete(id);
  state.preAckCompletions++;
  recordCompletions(state, [{ id, status: early.status }], early.observed);
}
