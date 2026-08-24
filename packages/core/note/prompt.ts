/**
 * Prompt construction for note structuring (FR10/FR11).
 *
 * Pure string-building: takes an aligned transcript + screenshot timeline and
 * produces the messages array for the LLM call. The prompt requires every
 * decision and action item to cite a segment id; enforcement of that
 * requirement happens on the response side, in schema.ts.
 */

import type { Screenshot, TranscriptSegment } from '../types';

export interface PromptInput {
  segments: TranscriptSegment[];
  screenshots: Screenshot[];
  /** Custom regeneration instruction (FR11), e.g. "focus on action items only". */
  instruction?: string;
}

const SYSTEM_PROMPT = `You are structuring notes from a meeting transcript for the person who attended it.

Rules:
- Every decision and every action item MUST include a "citations" array of transcript segment ids that support it. Use the ids given, e.g. "seg_12". Do not invent ids.
- If you cannot point to a specific segment that supports a claim, do not include the claim at all.
- Do not include anything not grounded in the transcript. Do not infer intentions beyond what was said.
- Reference screenshots (by id, e.g. "shot_3") in the sections whose discussion they illustrate, at the point they were shown -- not collected at the end.
- Respond with a single JSON object matching the schema described in the user message. No prose outside the JSON.`;

export function buildNotePrompt(input: PromptInput): { system: string; user: string } {
  const timeline = buildTimeline(input.segments, input.screenshots);
  const instructionLine = input.instruction
    ? `\nAdditional instruction for this pass: ${input.instruction}\n`
    : '';

  const user = `Transcript and screenshot timeline, in chronological order:

${timeline}
${instructionLine}
Produce a JSON object with this shape:
{
  "title": string,
  "summary": string,
  "decisions": [{ "text": string, "citations": string[] }],
  "actionItems": [{ "text": string, "owner": string | null, "citations": string[] }],
  "openQuestions": string[],
  "sections": [{ "heading": string, "body": string, "screenshotIds": string[] }]
}`;

  return { system: SYSTEM_PROMPT, user };
}

function buildTimeline(segments: TranscriptSegment[], screenshots: Screenshot[]): string {
  type Item = { atMs: number; line: string };
  const items: Item[] = [];

  for (const seg of segments) {
    const speakerLabel = seg.speaker === 'me' ? 'Me' : seg.speaker === 'them' ? 'Them' : 'Unknown';
    items.push({ atMs: seg.startMs, line: `[${formatTime(seg.startMs)}] (${seg.id}) ${speakerLabel}: ${seg.text}` });
  }
  for (const shot of screenshots) {
    items.push({ atMs: shot.timestampMs, line: `[${formatTime(shot.timestampMs)}] (${shot.id}) [screenshot shown]` });
  }

  items.sort((a, b) => a.atMs - b.atMs);
  return items.map((i) => i.line).join('\n');
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
