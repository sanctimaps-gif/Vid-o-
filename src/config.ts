import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

/** Polices candidates, par ordre de préférence, testées si l'utilisateur n'en impose pas. */
const BOLD_FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "C:\\Windows\\Fonts\\arialbd.ttf",
  "C:\\Windows\\Fonts\\segoeuib.ttf",
];

const REGULAR_FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
];

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* chemin illisible : on passe au suivant */
    }
  }
  return null;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "non", "off"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type TtsProvider = "edge" | "elevenlabs" | "none";

export const config = {
  model: process.env.VIDO_MODEL || "claude-opus-5",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",

  tts: (process.env.VIDO_TTS || "edge") as TtsProvider,
  edgeVoice: process.env.VIDO_EDGE_VOICE || "fr-FR-DeniseNeural",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "",
  elevenLabsVoiceId: process.env.VIDO_ELEVENLABS_VOICE_ID || "",
  elevenLabsModel: process.env.VIDO_ELEVENLABS_MODEL || "eleven_multilingual_v2",

  ffmpeg: process.env.VIDO_FFMPEG || "ffmpeg",
  ffprobe: process.env.VIDO_FFPROBE || "ffprobe",
  fontBold: process.env.VIDO_FONT_BOLD || firstExisting(BOLD_FONT_CANDIDATES),
  fontRegular: process.env.VIDO_FONT_REGULAR || firstExisting(REGULAR_FONT_CANDIDATES),
  musicDir: process.env.VIDO_MUSIC_DIR || path.join("assets", "music"),

  maxPages: int(process.env.VIDO_MAX_PAGES, 14),
  respectRobots: bool(process.env.VIDO_RESPECT_ROBOTS, true),

  port: int(process.env.PORT, 4173),

  userAgent:
    "Mozilla/5.0 (compatible; VidO/1.0; +https://github.com/sanctimaps-gif/Vid-o-) Chrome/124 Safari/537.36",
} as const;

/** Format cible : YouTube Shorts / TikTok / Reels. */
export const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
  /** Les fonds sont composés en 2x pour que le zoom ne pixellise pas. */
  bgScale: 2,
} as const;
