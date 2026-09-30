/**
 * Montage de la visite filmée : l'enregistrement brut du navigateur, la carte de
 * fin, et la musique s'il y en a une, assemblés en un MP4 vertical prêt à publier.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { ffmpeg, probeDuration } from "../render/ffmpeg.js";

export interface AssembleOptions {
  /** Enregistrement brut produit par le navigateur. */
  video: string;
  /** Image fixe de clôture, et sa durée. */
  endCard?: string | null;
  endCardSeconds?: number;
  /** Fichier audio de fond. Aucune musique n'est inventée. */
  music?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  out: string;
}

const MUSIC_LEVEL = 0.5;

/**
 * L'enregistrement arrive à la taille du viewport : il faut l'agrandir. `lanczos`
 * tient mieux les textes fins d'une interface que le filtre par défaut, et le
 * cadrage force le format vertical même si la source s'en écarte d'un pixel.
 */
function fitFilter(width: number, height: number, fps: number): string {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height},fps=${fps},format=yuv420p`
  );
}

export async function assembleTour(options: AssembleOptions): Promise<{ file: string; seconds: number }> {
  const {
    video,
    endCard = null,
    endCardSeconds = 2.6,
    music = null,
    width = 1080,
    height = 1920,
    fps = 30,
    out,
  } = options;

  await fs.mkdir(path.dirname(out), { recursive: true });
  const work = path.join(path.dirname(out), ".travail");
  await fs.mkdir(work, { recursive: true });

  // 1. L'enregistrement, mis au format.
  const body = path.join(work, "corps.mp4");
  await ffmpeg([
    "-i",
    video,
    "-vf",
    fitFilter(width, height, fps),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    body,
  ]);

  // 2. La carte de fin, transformée en court plan fixe au même format.
  const parts = [body];
  if (endCard) {
    const tail = path.join(work, "fin.mp4");
    await ffmpeg([
      "-loop",
      "1",
      "-t",
      String(endCardSeconds),
      "-i",
      endCard,
      "-vf",
      `${fitFilter(width, height, fps)},fade=t=in:st=0:d=0.4`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      tail,
    ]);
    parts.push(tail);
  }

  // 3. Mise bout à bout. Le démuxeur `concat` recopie les flux sans les réencoder,
  //    ce qui n'est possible que parce que les deux plans sortent des mêmes réglages.
  const silent = path.join(work, "muet.mp4");
  if (parts.length === 1) {
    await fs.copyFile(body, silent);
  } else {
    const list = path.join(work, "liste.txt");
    await fs.writeFile(list, parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join("\n"));
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);
  }

  const seconds = await probeDuration(silent);

  // 4. La musique, si l'utilisateur en a fourni une : coupée à la bonne longueur,
  //    avec une ouverture et une fermeture en fondu, puis normalisée.
  if (music) {
    await ffmpeg([
      "-i",
      silent,
      "-i",
      music,
      "-filter_complex",
      `[1:a]atrim=0:${seconds.toFixed(2)},afade=t=in:st=0:d=1.2,` +
        `afade=t=out:st=${Math.max(0, seconds - 1.6).toFixed(2)}:d=1.6,` +
        `volume=${MUSIC_LEVEL},loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
      "-map",
      "0:v",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      out,
    ]);
  } else {
    await ffmpeg(["-i", silent, "-c", "copy", "-movflags", "+faststart", out]);
  }

  await fs.rm(work, { recursive: true, force: true });
  return { file: out, seconds };
}
