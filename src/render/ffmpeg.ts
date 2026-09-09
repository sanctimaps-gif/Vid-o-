import { spawn } from "node:child_process";
import { config } from "../config.js";

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Un rendu long peut produire beaucoup de logs : on garde la fin, qui contient l'erreur.
      if (stderr.length > 40_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", (error) => {
      const hint =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `${bin} est introuvable. Installez FFmpeg (https://ffmpeg.org/download.html) ou renseignez VIDO_FFMPEG / VIDO_FFPROBE.`
          : error.message;
      reject(new FfmpegError(hint, ""));
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new FfmpegError(`${bin} a échoué (code ${code})`, stderr));
    });
  });
}

export function ffmpeg(args: string[]): Promise<string> {
  return run(config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

export function ffprobe(args: string[]): Promise<string> {
  return run(config.ffprobe, args);
}

/** Durée d'un média en secondes, 0 si indéterminable. */
export async function probeDuration(file: string): Promise<number> {
  const output = await ffprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const duration = Number.parseFloat(output.trim());
  return Number.isFinite(duration) ? duration : 0;
}

export async function probeImageSize(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const output = await ffprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0:s=x",
      file,
    ]);
    const [width, height] = output.trim().split("x").map(Number);
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  }
}

let cachedFilters: Set<string> | null = null;

/** Liste les filtres disponibles dans le FFmpeg installé (les builds minimales en omettent). */
export async function availableFilters(): Promise<Set<string>> {
  if (cachedFilters) return cachedFilters;
  const output = await run(config.ffmpeg, ["-hide_banner", "-filters"]);
  const filters = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^\s*[A-Z.]{3,}\s+(\S+)\s/.exec(line);
    if (match?.[1]) filters.add(match[1]);
  }
  cachedFilters = filters;
  return filters;
}

export async function hasFilter(name: string): Promise<boolean> {
  return (await availableFilters()).has(name);
}

/**
 * Échappe un chemin destiné à une option de filtre (`textfile=`, `fontfile=`).
 * FFmpeg y interprète `\`, `:` et `'`.
 */
export function escapeFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/([:',[\]])/g, "\\$1");
}

/** Échappe une valeur littérale placée dans un filtre (couleurs, expressions). */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

export async function ffmpegVersion(): Promise<string> {
  const output = await run(config.ffmpeg, ["-version"]);
  return output.split("\n")[0]?.trim() ?? "inconnue";
}
