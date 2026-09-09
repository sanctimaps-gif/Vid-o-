import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VIDEO } from "../config.js";
import { ffmpeg, hasFilter } from "./ffmpeg.js";

const BG_W = VIDEO.width * VIDEO.bgScale;
const BG_H = VIDEO.height * VIDEO.bgScale;

/** `#1e1b4b` -> `0x1e1b4b`, avec repli sur une couleur sûre. */
export function toFfmpegColor(hex: string, fallback = "#111827"): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const value = match?.[1] ?? /^#?([0-9a-fA-F]{6})$/.exec(fallback)?.[1] ?? "111827";
  return `0x${value.toLowerCase()}`;
}

/** Éclaircit ou assombrit une couleur hex, pour dériver un dégradé cohérent. */
export function shiftColor(hex: string, amount: number): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match?.[1]) return hex;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16));
  const shifted = channels.map((channel) =>
    Math.max(0, Math.min(255, Math.round(channel + amount * 255))),
  );
  return `#${shifted.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Compose le fond d'une scène à partir d'une image du site :
 * un flou plein cadre en arrière-plan, la photo entière posée par-dessus.
 * Les photos produit (souvent carrées, sur fond blanc) tiennent ainsi en 9:16 sans être rognées.
 */
export async function buildImageBackground(
  imagePath: string,
  outPath: string,
  options: { backgroundColor: string },
): Promise<void> {
  const base = toFfmpegColor(options.backgroundColor);
  const blurFilter = (await hasFilter("gblur")) ? "gblur=sigma=42" : "boxblur=40:2";

  const filter = [
    `color=c=${base}:s=${BG_W}x${BG_H}[canvas]`,
    "[0:v]split=2[blurred][sharp]",
    `[blurred]scale=${BG_W}:${BG_H}:force_original_aspect_ratio=increase,crop=${BG_W}:${BG_H},` +
      `${blurFilter},eq=brightness=-0.16:saturation=1.1[bg]`,
    "[canvas][bg]overlay=0:0[base]",
    `[sharp]scale=${Math.round(BG_W * 0.94)}:${Math.round(BG_H * 0.66)}:force_original_aspect_ratio=decrease[fg]`,
    "[base][fg]overlay=(W-w)/2:(H-h)/2-120[out]",
  ].join(";");

  await ffmpeg([
    "-i",
    imagePath,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outPath,
  ]);
}

/** Fond sans photo : dégradé de marque + vignettage, pour les scènes de texte et le call to action. */
export async function buildColorBackground(
  outPath: string,
  options: { backgroundColor: string; accentColor: string },
): Promise<void> {
  const top = toFfmpegColor(shiftColor(options.backgroundColor, 0.07));
  const bottom = toFfmpegColor(shiftColor(options.backgroundColor, -0.05));
  const accent = toFfmpegColor(options.accentColor, "#f43f5e");

  // Halo radial centré haut : le regard tombe sur le texte, pas sur les bords.
  const source = (await hasFilter("gradients"))
    ? `gradients=s=${BG_W}x${BG_H}:c0=${top}:c1=${bottom}:type=radial:` +
      `x0=${Math.round(BG_W / 2)}:y0=${Math.round(BG_H * 0.34)}:x1=0:y1=${BG_H}:nb_colors=2:d=1:speed=0.00001`
    : `color=c=${bottom}:s=${BG_W}x${BG_H}:d=1`;

  void accent;
  const chain = (await hasFilter("vignette")) ? "vignette=PI/4.5" : "null";

  await ffmpeg(["-f", "lavfi", "-i", source, "-vf", chain, "-frames:v", "1", "-q:v", "2", outPath]);
}

/**
 * Voile de lisibilité : un dégradé transparent, sombre en haut et en bas du cadre.
 * Généré une fois puis superposé après le zoom, pour que ses bords restent alignés sur l'écran.
 */
export async function buildScrim(outPath: string): Promise<void> {
  const { width, height } = VIDEO;
  const topEnd = 480;
  const bottomStart = 1130;

  // Deux rampes d'opacité, aucune bande visible.
  const alpha =
    `if(lt(Y,${topEnd}), 150*pow(1-Y/${topEnd},1.4),` +
    ` if(gt(Y,${bottomStart}), 185*pow((Y-${bottomStart})/${height - bottomStart},0.8), 0))`;

  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${width}x${height}:d=1`,
    "-vf",
    `format=rgba,geq=r=0:g=0:b=0:a='${alpha}'`,
    "-frames:v",
    "1",
    outPath,
  ]);
}

/* ------------------------------------------------------------------ *
 * Couleur de marque déduite d'une image
 * ------------------------------------------------------------------ */

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) hue = ((bn - rn) / delta + 2) / 6;
  else hue = ((rn - gn) / delta + 4) / 6;
  return [hue, saturation, lightness];
}

function hslToHex(h: number, s: number, l: number): string {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - chroma / 2;
  const sector = Math.floor(h * 6) % 6;
  const table: Array<[number, number, number]> = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  const [r, g, b] = table[sector] ?? [chroma, x, 0];
  return `#${[r, g, b]
    .map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Couleur d'accent tirée d'une image : on réduit l'image à 8x8 puis on garde
 * la teinte la plus franche, ramenée à une saturation et une clarté lisibles sur fond sombre.
 */
export async function dominantColor(imagePath: string): Promise<string | null> {
  const rawPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vido-color-")), "px.raw");
  try {
    await ffmpeg([
      "-i",
      imagePath,
      "-vf",
      "scale=8:8:flags=area",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-frames:v",
      "1",
      rawPath,
    ]);
    const pixels = await fs.readFile(rawPath);

    let best: { hue: number; saturation: number } | null = null;
    for (let offset = 0; offset + 2 < pixels.length; offset += 3) {
      const [hue, saturation, lightness] = rgbToHsl(
        pixels[offset]!,
        pixels[offset + 1]!,
        pixels[offset + 2]!,
      );
      // Les zones presque blanches ou presque noires ne disent rien de la marque.
      if (lightness < 0.12 || lightness > 0.92) continue;
      if (!best || saturation > best.saturation) best = { hue, saturation };
    }

    if (!best || best.saturation < 0.12) return null;
    return hslToHex(best.hue, Math.min(0.85, Math.max(0.62, best.saturation)), 0.56);
  } catch {
    return null;
  } finally {
    await fs.rm(path.dirname(rawPath), { recursive: true, force: true });
  }
}
