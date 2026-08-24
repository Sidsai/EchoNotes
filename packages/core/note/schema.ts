/**
 * Validation for LLM-produced structured notes (FR10).
 *
 * The PRD's stated risk is that an LLM invents action items or decisions that
 * were never actually said. The mitigation designed for that is grounding:
 * the prompt (see prompt.ts) requires every decision and action item to cite
 * the id of a real transcript segment. This module is the enforcement side --
 * it validates the LLM's raw JSON response against the actual segment ids
 * that existed for the session, and strips any claim that cites a segment
 * that doesn't exist or cites nothing at all. A hallucinated citation is
 * exactly as useless as no citation, so both are treated the same way.
 *
 * This is a pure function over data (no network call, no SDK) so the
 * grounding behaviour is testable without hitting a real LLM.
 */

import type { ActionItem, Decision, StructuredNote } from '../types';

export interface ValidationResult {
  note: StructuredNote;
  /** Human-readable notes on what was dropped and why, for logging (per the PRD's Observability NFR). */
  droppedClaims: string[];
}

/**
 * `raw` is the parsed JSON body from the LLM response, shaped like
 * StructuredNote but not yet trusted. `validSegmentIds` is the ground truth:
 * every segment id that actually exists for this session.
 */
export function validateStructuredNote(
  raw: unknown,
  validSegmentIds: ReadonlySet<string>,
): ValidationResult {
  const droppedClaims: string[] = [];
  const candidate = coerceShape(raw);

  const decisions: Decision[] = [];
  for (const d of candidate.decisions) {
    const citations = d.citations.filter((id) => validSegmentIds.has(id));
    if (citations.length === 0) {
      droppedClaims.push(`decision "${truncate(d.text)}" dropped: no valid citation`);
      continue;
    }
    decisions.push({ text: d.text, citations });
  }

  const actionItems: ActionItem[] = [];
  for (const a of candidate.actionItems) {
    const citations = a.citations.filter((id) => validSegmentIds.has(id));
    if (citations.length === 0) {
      droppedClaims.push(`action item "${truncate(a.text)}" dropped: no valid citation`);
      continue;
    }
    actionItems.push({ text: a.text, owner: a.owner, citations });
  }

  const note: StructuredNote = {
    sessionId: candidate.sessionId,
    generatedAt: candidate.generatedAt,
    title: candidate.title,
    summary: candidate.summary,
    decisions,
    actionItems,
    openQuestions: candidate.openQuestions,
    sections: candidate.sections,
    ...(candidate.instruction !== undefined ? { instruction: candidate.instruction } : {}),
  };

  return { note, droppedClaims };
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

interface CoercedNote {
  sessionId: string;
  generatedAt: number;
  title: string;
  summary: string;
  decisions: Array<{ text: string; citations: string[] }>;
  actionItems: Array<{ text: string; owner: string | null; citations: string[] }>;
  openQuestions: string[];
  sections: StructuredNote['sections'];
  instruction?: string;
}

/**
 * Defensive shape coercion for LLM JSON output: fields the model omits or
 * gets wrong become safe empty defaults rather than throwing, since the
 * failure mode we care about is a missing citation array, not a missing key.
 */
function coerceShape(raw: unknown): CoercedNote {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
    generatedAt: typeof r.generatedAt === 'number' ? r.generatedAt : Date.now(),
    title: typeof r.title === 'string' ? r.title : 'Untitled meeting',
    summary: typeof r.summary === 'string' ? r.summary : '',
    decisions: coerceCitedList(r.decisions),
    actionItems: coerceActionItems(r.actionItems),
    openQuestions: Array.isArray(r.openQuestions) ? r.openQuestions.filter((q) => typeof q === 'string') : [],
    sections: coerceSections(r.sections),
    ...(typeof r.instruction === 'string' ? { instruction: r.instruction } : {}),
  };
}

function coerceCitedList(value: unknown): Array<{ text: string; citations: string[] }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      text: typeof v.text === 'string' ? v.text : '',
      citations: Array.isArray(v.citations) ? v.citations.filter((c): c is string => typeof c === 'string') : [],
    }));
}

function coerceActionItems(value: unknown): Array<{ text: string; owner: string | null; citations: string[] }> {
  return coerceCitedList(value).map((item, i) => {
    const raw = (value as Array<Record<string, unknown>>)[i];
    const owner = typeof raw?.owner === 'string' ? raw.owner : null;
    return { ...item, owner };
  });
}

function coerceSections(value: unknown): StructuredNote['sections'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      heading: typeof v.heading === 'string' ? v.heading : '',
      body: typeof v.body === 'string' ? v.body : '',
      screenshotIds: Array.isArray(v.screenshotIds) ? v.screenshotIds.filter((s): s is string => typeof s === 'string') : [],
    }));
}
