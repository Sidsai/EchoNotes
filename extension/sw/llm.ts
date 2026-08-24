/**
 * Anthropic Messages API client, called directly from the service worker via
 * `anthropic-dangerous-direct-browser-access` -- Anthropic's own supported
 * mechanism for "bring your own API key" client-side apps like this one
 * (announced August 2024), which is what makes a server-side proxy
 * unnecessary here. This is the one step in the pipeline that intentionally
 * leaves the device, per the PRD's architecture: only transcript text and
 * screenshot timestamps are sent, never raw audio or images.
 *
 * Not exercised against the real API from this environment -- see the
 * README's Verification section.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 4096;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmRequest {
  system: string;
  user: string;
  apiKey: string;
}

/** Returns the raw text of Claude's response. Parsing/validating it as a StructuredNote happens in finalize.ts. */
export async function callClaude(request: LlmRequest): Promise<string> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': request.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new LlmError(`Claude API request failed (${response.status}): ${body.slice(0, 500)}`, response.status);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const textBlock = data.content?.find((block) => block.type === 'text' && typeof block.text === 'string');
  if (!textBlock?.text) {
    throw new LlmError('Claude API response contained no text content block');
  }
  return textBlock.text;
}

/**
 * Claude is instructed to respond with a single JSON object and no
 * surrounding prose, but models occasionally wrap output in a markdown code
 * fence anyway. Strips one if present rather than trusting the instruction
 * was followed exactly.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const jsonText = fenced ? fenced[1]! : trimmed;
  return JSON.parse(jsonText);
}
