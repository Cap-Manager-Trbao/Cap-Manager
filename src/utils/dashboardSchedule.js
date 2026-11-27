import { normalizeMatrix } from './capAlgorithm.js';

/**
 * Find the latest saved history record for a given YYYY-MM-DD date.
 * Only saved history records are published to Dashboard.
 */
export function getSavedDistributionForDate(history, dateStr) {
  if (!Array.isArray(history) || !dateStr) return null;
  const matching = history.filter((rec) => rec && rec.date === dateStr);
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];
  return [...matching].sort((a, b) =>
    String(b.savedAt || '').localeCompare(String(a.savedAt || ''))
  )[0];
}

/**
 * Collect all YYYY-MM-DD dates that have a saved CAP distribution.
 */
export function getSavedDatesSet(history) {
  const dates = new Set();
  if (!Array.isArray(history)) return dates;
  for (const rec of history) {
    if (rec && typeof rec.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.date)) {
      dates.add(rec.date);
    }
  }
  return dates;
}

/**
 * Check whether the current draft distribution differs from the saved record for that date.
 */
export function hasMatrixChangesSinceSaved(savedRecord, currentMatrix, campaigns = [], members = []) {
  if (!savedRecord) return true;
  const savedCampaigns = Array.isArray(savedRecord.campaigns) ? savedRecord.campaigns : [];
  const savedMembers = Array.isArray(savedRecord.members) ? savedRecord.members : [];
  if (savedCampaigns.length !== campaigns.length || savedMembers.length !== members.length) {
    return true;
  }

  const savedMap = new Map(savedCampaigns.map((c) => [c.id, c]));
  for (const camp of campaigns) {
    const prev = savedMap.get(camp.id);
    if (
      !prev ||
      Number(prev.totalCap) !== Number(camp.totalCap) ||
      Number(prev.pointsPerCap) !== Number(camp.pointsPerCap) ||
      String(prev.capHour || '') !== String(camp.capHour || '')
    ) {
      return true;
    }
  }

  const normalizedDraft = normalizeMatrix(currentMatrix, campaigns, members);
  const normalizedSaved = normalizeMatrix(savedRecord.matrix, campaigns, members);

  for (const camp of campaigns) {
    for (const mem of members) {
      const a = Number(normalizedDraft[camp.id]?.[mem.id] ?? 0);
      const b = Number(normalizedSaved[camp.id]?.[mem.id] ?? 0);
      if (a !== b) return true;
    }
  }

  return false;
}
