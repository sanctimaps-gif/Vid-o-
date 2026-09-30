/**
 * Enchaînement complet d'une visite filmée : on ouvre le site, on s'en sert
 * devant la caméra, on ajoute la carte de fin et la musique.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { recordTour, type TourResult } from "./tour.js";
import { renderEndCard } from "./endcard.js";
import { assembleTour } from "./assemble.js";
import { log } from "../util/log.js";

export interface TourJobOptions {
  url: string;
  outDir: string;
  seconds?: number;
  width?: number;
  music?: string | null;
  /** Phrase de clôture. Sans elle, celle du site est reprise. */
  tagline?: string;
  endCard?: boolean;
  onProgress?: (message: string) => void;
}

export interface TourJobResult {
  file: string;
  seconds: number;
  steps: string[];
  siteName: string;
}

function slugify(input: string): string {
  return (
    String(input)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "visite"
  );
}

export async function generateTour(options: TourJobOptions): Promise<TourJobResult> {
  const {
    url,
    outDir,
    seconds = 22,
    width = 540,
    music = null,
    tagline,
    endCard = true,
    onProgress,
  } = options;

  const domain = new URL(url).hostname.replace(/^www\./, "");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(2);
  const dir = path.join(outDir, `${slugify(domain)}-visite-${stamp}`);
  await fs.mkdir(dir, { recursive: true });

  onProgress?.("ouverture du navigateur");
  const tour: TourResult = await recordTour({
    url,
    outDir: dir,
    seconds,
    width,
    onProgress,
  });

  let card: string | null = null;
  if (endCard) {
    onProgress?.("carte de fin");
    try {
      card = await renderEndCard({
        siteName: tour.siteName || domain,
        tagline: tagline ?? tour.description,
        domain,
        logo: tour.logo,
        width,
        outDir: dir,
      });
    } catch (error) {
      // La carte de fin est un bonus : son échec ne doit pas coûter la vidéo.
      log.warn(`carte de fin impossible : ${(error as Error).message}`);
    }
  }

  onProgress?.("montage");
  const out = path.join(dir, `${slugify(domain)}-visite.mp4`);
  const { seconds: total } = await assembleTour({
    video: tour.video,
    endCard: card,
    music,
    out,
  });

  // L'enregistrement brut ne sert plus à rien une fois monté.
  await fs.rm(path.join(dir, "raw"), { recursive: true, force: true });

  await fs.writeFile(
    path.join(dir, "visite.json"),
    JSON.stringify(
      {
        url,
        siteName: tour.siteName,
        description: tour.description,
        steps: tour.steps,
        seconds: total,
        file: path.basename(out),
      },
      null,
      2,
    ),
  );

  return { file: out, seconds: total, steps: tour.steps, siteName: tour.siteName || domain };
}
