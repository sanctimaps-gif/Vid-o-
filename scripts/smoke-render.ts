/**
 * Rendu de démonstration : vérifie toute la chaîne vidéo (fonds, incrustations, audio, montage)
 * sans appeler ni le site distant, ni le modèle. Aucune clé API requise.
 *
 *   npm run smoke
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderVideo } from "../src/render/renderShort.js";
import { createSpeaker } from "../src/tts/index.js";
import type { CampaignPlan, SiteSnapshot } from "../src/types.js";
import { ffmpeg } from "../src/render/ffmpeg.js";
import { log } from "../src/util/log.js";

const PALETTE = ["0x1f2937", "0x7c2d12", "0x134e4a"];

async function makeSampleImages(dir: string): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const [index, color] of PALETTE.entries()) {
    const file = path.join(dir, `sample-${index}.jpg`);
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `gradients=s=1400x1400:c0=${color}:c1=0xf1f5f9:type=radial:x0=700:y0=700:x1=0:y1=1400:d=1`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      file,
    ]);
    files.push(file);
  }
  return files;
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vido-smoke-"));
  const outDir = path.join(root, "out");
  const images = await makeSampleImages(path.join(root, "images"));

  const site: SiteSnapshot = {
    url: "https://exemple-boutique.fr",
    origin: "https://exemple-boutique.fr",
    domain: "exemple-boutique.fr",
    siteName: "Exemple Boutique",
    title: "Exemple Boutique",
    description: "Boutique de démonstration",
    pageText: "",
    products: [],
    pagesVisited: [],
    images: images.map((localPath, index) => ({
      index,
      url: `https://exemple-boutique.fr/img-${index}.jpg`,
      alt: `visuel ${index}`,
      source: "démo",
      localPath,
    })),
  };

  const plan: CampaignPlan = {
    language: "fr",
    brandName: "Exemple Boutique",
    brandSummary: "Boutique de démonstration",
    accentColor: "#f43f5e",
    backgroundColor: "#0f172a",
    videos: [
      {
        slug: "demo",
        concept: "Vérification du rendu",
        youtubeTitle: "Le rendu Vid-O en trente secondes #Shorts",
        youtubeDescription: "Vidéo de démonstration produite par Vid-O.",
        hashtags: ["mode", "boutique"],
        tags: ["demo", "vido"],
        scenes: [
          {
            narration: "Voici a quoi ressemble un Short genere automatiquement depuis votre site.",
            onScreenText: "RENDU DE DEMO",
            imageIndex: 0,
            role: "hook",
          },
          {
            narration: "Les visuels du site defilent avec un leger zoom, sous-titres synchronises.",
            onScreenText: "Zoom et sous-titres",
            imageIndex: 1,
            role: "body",
          },
          {
            narration: "Sans image disponible, le fond reprend les couleurs de la marque.",
            onScreenText: "Fond de marque",
            imageIndex: -1,
            role: "body",
          },
          {
            narration: "Rendez-vous sur le site pour decouvrir la collection.",
            onScreenText: "A VOUS DE JOUER",
            imageIndex: 2,
            role: "cta",
          },
        ],
      },
    ],
  };

  const speaker = await createSpeaker({ provider: process.env.VIDO_TTS as never });
  log.info(`voix off : ${speaker.name}`);

  const started = Date.now();
  const video = await renderVideo(plan.videos[0]!, {
    plan,
    site,
    speaker,
    musicPath: null,
    outDir,
    workRoot: path.join(root, "work"),
    videoIndex: 1,
    videoTotal: 3,
    onProgress: (message) => log.step(message),
  });

  log.success(`rendu en ${Math.round((Date.now() - started) / 1000)}s`);
  log.info(`vidéo    : ${video.videoPath} (${video.durationSeconds}s)`);
  log.info(`miniature: ${video.thumbnailPath}`);
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
    console.error(error.stderr.split("\n").slice(-15).join("\n"));
  }
  process.exitCode = 1;
});
