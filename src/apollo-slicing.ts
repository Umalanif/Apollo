import { normalizePeopleSearchPayload } from './crawler';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SLICE_CAP_TOTAL_ENTRIES = 150;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getSliceLetters(): string[] {
  return LETTERS.split('');
}

export function planSlicePages(totalEntries: number | null | undefined, perPage = 30): number[] {
  if (totalEntries == null) {
    return [1];
  }

  if (totalEntries <= 0) {
    return [];
  }

  if (totalEntries > SLICE_CAP_TOTAL_ENTRIES) {
    return [1, 2, 3];
  }

  const totalPages = Math.max(1, Math.ceil(totalEntries / perPage));
  return Array.from({ length: totalPages }, (_, index) => index + 1);
}

export function getApolloPaginationTotals(
  payload: unknown,
  fallbackPerPage = 30,
): { totalEntries: number | null; perPage: number } {
  if (!isRecord(payload) || !isRecord(payload.pagination)) {
    return { totalEntries: null, perPage: fallbackPerPage };
  }

  const totalEntries = typeof payload.pagination.total_entries === 'number'
    ? payload.pagination.total_entries
    : null;
  const perPage = typeof payload.pagination.per_page === 'number'
    ? payload.pagination.per_page
    : fallbackPerPage;

  return { totalEntries, perPage };
}

export function buildSliceReplayPayload(rawPayload: unknown, letter: string, page: number): Record<string, unknown> {
  return {
    ...normalizePeopleSearchPayload(rawPayload, page),
    person_first_names: [letter],
    page,
  };
}
