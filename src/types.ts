import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Ce que l'on extrait du site
 * ------------------------------------------------------------------ */

export interface SiteImage {
  /** Index stable, c'est ce numéro que le modèle choisit pour illustrer une scène. */
  index: number;
  url: string;
  /** Texte alternatif / légende, sert au modèle pour savoir ce que l'image montre. */
  alt: string;
  /** Titre de la page ou du produit d'où vient l'image. */
  source: string;
  localPath?: string;
  width?: number;
  height?: number;
}

export interface SiteProduct {
  title: string;
  url: string;
  price?: string;
  description?: string;
  imageIndexes: number[];
}

export interface SiteSnapshot {
  url: string;
  origin: string;
  domain: string;
  siteName: string;
  /** Code langue déclaré par la page, sert au rédacteur hors ligne. */
  lang: string;
  title: string;
  description: string;
  /** Texte lisible de la page d'accueil, tronqué. */
  pageText: string;
  products: SiteProduct[];
  images: SiteImage[];
  pagesVisited: string[];
}

/* ------------------------------------------------------------------ *
 * Ce que le modèle écrit
 * ------------------------------------------------------------------ */

export const SceneSchema = z.object({
  /** Texte dit par la voix off. Une à deux phrases courtes. */
  narration: z.string(),
  /** Texte incrusté à l'écran. Très court : 2 à 6 mots. */
  onScreenText: z.string(),
  /** Index d'une image du site (voir la liste fournie), ou -1 pour un fond uni. */
  imageIndex: z.number(),
  /** Rôle de la scène dans le montage. */
  role: z.enum(["hook", "body", "cta"]),
});

export const VideoPlanSchema = z.object({
  /** Identifiant de fichier, en minuscules sans accents ni espaces. */
  slug: z.string(),
  /** Angle de la vidéo, une phrase, pour l'interface. */
  concept: z.string(),
  scenes: z.array(SceneSchema),
  /** Titre YouTube, moins de 90 caractères, avec #Shorts. */
  youtubeTitle: z.string(),
  /** Description YouTube, 2 à 4 lignes + lien du site. */
  youtubeDescription: z.string(),
  /** Hashtags sans le # (ils sont ajoutés au rendu). */
  hashtags: z.array(z.string()),
  /** Mots-clés YouTube. */
  tags: z.array(z.string()),
});

export const CampaignPlanSchema = z.object({
  /** Code langue de la campagne, ex. "fr" ou "en". */
  language: z.string(),
  brandName: z.string(),
  /** Ce que vend le site, en une phrase. */
  brandSummary: z.string(),
  /** Couleur d'accent hex (#RRGGBB) tirée de l'univers de la marque. */
  accentColor: z.string(),
  /** Couleur de fond hex (#RRGGBB), sombre de préférence. */
  backgroundColor: z.string(),
  videos: z.array(VideoPlanSchema),
});

export type Scene = z.infer<typeof SceneSchema>;
export type VideoPlan = z.infer<typeof VideoPlanSchema>;
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

/* ------------------------------------------------------------------ *
 * Ce que l'on produit
 * ------------------------------------------------------------------ */

export interface RenderedVideo {
  slug: string;
  concept: string;
  videoPath: string;
  thumbnailPath: string;
  metadataPath: string;
  durationSeconds: number;
  youtubeTitle: string;
  youtubeDescription: string;
  hashtags: string[];
  tags: string[];
}

export interface GenerateOptions {
  url: string;
  brief: string;
  count?: number;
  outDir: string;
  tts?: "edge" | "elevenlabs" | "none";
  voice?: string;
  musicDir?: string;
  /** Plan déjà écrit (JSON), pour re-rendre sans repasser par le modèle. */
  planPath?: string;
  /** Rédacteur à utiliser : auto, template, ollama, groq, gemini, openrouter, mistral, custom, anthropic. */
  writer?: string;
  onProgress?: (step: string, detail?: string) => void;
}
