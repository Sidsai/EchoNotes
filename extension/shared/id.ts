/** Session-scoped id generation. Not cryptographic -- just needs to be unique within one user's local data. */
export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}${rand[0]!.toString(36)}${rand[1]!.toString(36)}`;
}
