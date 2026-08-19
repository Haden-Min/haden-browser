export function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };

  const marker = "\n\n[output truncated; narrow the selector or raise maxChars]";
  const available = Math.max(0, maxChars - marker.length);
  const candidate = value.slice(0, available);
  const naturalBreak = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
  const end = naturalBreak >= available * 0.8 ? naturalBreak : available;
  return { text: `${candidate.slice(0, end).trimEnd()}${marker}`, truncated: true };
}

export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}
