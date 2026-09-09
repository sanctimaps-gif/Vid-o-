/** Remplace les caractères qu'aucune police système ne rend proprement. */
export function normalizeTypography(input: string): string {
  return input
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0|\u202f/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Coupe un texte en lignes d'au plus `maxChars` caractères.
 * `drawtext` n'ayant aucun retour à la ligne automatique, on le fait nous-mêmes.
 */
export function wrapText(input: string, maxChars: number): string[] {
  const words = normalizeTypography(input).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Découpe une narration en groupes de mots affichables comme sous-titres,
 * en cassant en priorité sur la ponctuation.
 */
export function chunkForCaptions(narration: string, maxWords = 4): string[] {
  const clean = normalizeTypography(narration);
  if (!clean) return [];

  const segments = clean
    .split(/(?<=[.!?,;:])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const segment of segments) {
    const words = segment.split(/\s+/);
    for (let i = 0; i < words.length; i += maxWords) {
      const chunk = words.slice(i, i + maxWords).join(" ");
      // Un dernier morceau d'un seul mot est recollé au précédent.
      const previous = chunks[chunks.length - 1];
      if (chunk.split(" ").length === 1 && previous && previous.split(" ").length < maxWords + 2) {
        chunks[chunks.length - 1] = `${previous} ${chunk}`;
      } else {
        chunks.push(chunk);
      }
    }
  }
  return chunks.map((chunk) => chunk.replace(/[.,;:]$/, ""));
}

/** Répartit une durée sur des morceaux de texte au prorata de leur longueur. */
export function distributeDurations(chunks: string[], total: number): Array<{ start: number; end: number }> {
  if (chunks.length === 0) return [];
  const weights = chunks.map((chunk) => Math.max(chunk.length, 6));
  const sum = weights.reduce((acc, weight) => acc + weight, 0);

  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const share = (weights[i] ?? 1) / sum;
    const end = i === chunks.length - 1 ? total : cursor + share * total;
    spans.push({ start: cursor, end });
    cursor = end;
  }
  return spans;
}

/** Estime la durée d'une lecture à voix haute (utilisé quand il n'y a pas de voix off). */
export function estimateSpeechSeconds(text: string): number {
  const words = normalizeTypography(text).split(/\s+/).filter(Boolean).length;
  return Math.max(1.6, words / 2.7);
}

export function slugify(input: string, fallback = "video"): string {
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

export function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1).trimEnd()}…`;
}
