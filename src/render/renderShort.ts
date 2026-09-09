import fs from "node:fs/promises";
import path from "node:path";
import { VIDEO, config } from "../config.js";
import type { CampaignPlan, RenderedVideo, SiteImage, SiteSnapshot, VideoPlan } from "../types.js";
import {
  chunkForCaptions,
  distributeDurations,
  estimateSpeechSeconds,
  normalizeTypography,
  truncate,
  wrapText,
} from "../util/text.js";
import { escapeFilterPath, ffmpeg, hasFilter, probeDuration } from "./ffmpeg.js";
import { buildColorBackground, buildImageBackground, buildScrim, toFfmpegColor } from "./visuals.js";
import type { Speaker } from "../tts/index.js";

const PAD_START = 0.22;
const PAD_END = 0.45;
const MIN_SCENE = 2.2;
const MAX_SCENE = 13;

/** Zones sûres : l'interface de YouTube Shorts recouvre le bas et la droite du cadre. */
const LAYOUT = {
  chipY: 96,
  chipSize: 34,
  headlineTop: 236,
  headlineSize: 76,
  headlineWrap: 20,
  captionCenterY: 1430,
  captionSize: 56,
  captionWrap: 26,
  progressY: 1878,
  progressHeight: 10,
} as const;

interface PreparedScene {
  index: number;
  narration: string;
  onScreenText: string;
  role: "hook" | "body" | "cta";
  backgroundPath: string;
  voicePath: string | null;
  voiceDuration: number;
  duration: number;
  startOffset: number;
}

export interface RenderContext {
  plan: CampaignPlan;
  site: SiteSnapshot;
  speaker: Speaker;
  musicPath: string | null;
  outDir: string;
  workRoot: string;
  videoIndex: number;
  videoTotal: number;
  onProgress?: (message: string) => void;
}

/** Contexte interne : `renderVideo` y ajoute le voile partagé par toutes les scènes. */
type SceneContext = RenderContext & { scrimPath: string };

function fontFileOrThrow(kind: "bold" | "regular"): string {
  const font = kind === "bold" ? config.fontBold : config.fontRegular;
  if (!font) {
    throw new Error(
      "Aucune police TrueType trouvée pour incruster le texte. " +
        "Installez par exemple `fonts-dejavu-core`, ou renseignez VIDO_FONT_BOLD et VIDO_FONT_REGULAR dans .env.",
    );
  }
  return font;
}

/** Construit une instruction `drawtext`. Le texte passe par un fichier : plus d'échappement à gérer. */
function drawText(options: {
  textFile: string;
  fontFile: string;
  fontSize: number;
  color: string;
  x: string;
  y: string;
  lineSpacing?: number;
  borderWidth?: number;
  borderColor?: string;
  boxColor?: string;
  boxPadding?: number;
  alpha?: string;
  enable?: string;
}): string {
  const parts = [
    `textfile=${escapeFilterPath(options.textFile)}`,
    `fontfile=${escapeFilterPath(options.fontFile)}`,
    `fontsize=${options.fontSize}`,
    `fontcolor=${options.color}`,
    `x=${options.x}`,
    `y=${options.y}`,
    `line_spacing=${options.lineSpacing ?? Math.round(options.fontSize * 0.28)}`,
    "text_align=C",
  ];
  if (options.boxColor) {
    parts.push("box=1", `boxcolor=${options.boxColor}`, `boxborderw=${options.boxPadding ?? 18}`);
  }
  if (options.borderWidth) {
    parts.push(`borderw=${options.borderWidth}`, `bordercolor=${options.borderColor ?? "black@0.85"}`);
  }
  if (options.alpha) parts.push(`alpha='${options.alpha}'`);
  if (options.enable) parts.push(`enable='${options.enable}'`);
  return `drawtext=${parts.join(":")}`;
}

async function writeTextFile(dir: string, name: string, lines: string[]): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, lines.join("\n"), "utf8");
  return file;
}

function pickImage(images: SiteImage[], index: number): SiteImage | null {
  const image = images.find((candidate) => candidate.index === index);
  return image?.localPath ? image : null;
}

/* ------------------------------------------------------------------ *
 * Préparation : voix off, durées, fonds
 * ------------------------------------------------------------------ */

async function prepareScenes(video: VideoPlan, ctx: RenderContext, workDir: string): Promise<PreparedScene[]> {
  const prepared: PreparedScene[] = [];
  let offset = 0;

  for (const [index, scene] of video.scenes.entries()) {
    const narration = normalizeTypography(scene.narration);
    const label = `${index + 1}/${video.scenes.length}`;
    ctx.onProgress?.(`voix off scène ${label}`);

    const voicePath = await ctx.speaker.speak(narration, path.join(workDir, `voice-${index}.mp3`));
    const voiceDuration = voicePath ? await probeDuration(voicePath) : 0;
    const spoken = voiceDuration > 0 ? voiceDuration : estimateSpeechSeconds(narration);
    const duration = Math.min(MAX_SCENE, Math.max(MIN_SCENE, spoken + PAD_START + PAD_END));

    const backgroundPath = path.join(workDir, `bg-${index}.jpg`);
    const image = pickImage(ctx.site.images, scene.imageIndex);
    if (image?.localPath) {
      try {
        await buildImageBackground(image.localPath, backgroundPath, {
          backgroundColor: ctx.plan.backgroundColor,
        });
      } catch {
        // Image illisible (format exotique, téléchargement tronqué) : on retombe sur un fond de marque.
        await buildColorBackground(backgroundPath, ctx.plan);
      }
    } else {
      await buildColorBackground(backgroundPath, ctx.plan);
    }

    prepared.push({
      index,
      narration,
      onScreenText: normalizeTypography(scene.onScreenText),
      role: scene.role,
      backgroundPath,
      voicePath,
      voiceDuration: spoken,
      duration,
      startOffset: offset,
    });
    offset += duration;
  }

  return prepared;
}

/* ------------------------------------------------------------------ *
 * Rendu d'une scène
 * ------------------------------------------------------------------ */

/**
 * Barre de progression de la vidéo entière, dessinée par paliers.
 * `drawbox` n'expose pas le temps dans ses expressions (`t` y désigne l'épaisseur),
 * on s'appuie donc sur `enable`, qui, lui, est piloté par la timeline.
 */
function progressBarFilters(scene: PreparedScene, totalDuration: number, accent: string): string[] {
  const step = 0.2;
  const filters: string[] = [
    `drawbox=x=0:y=${LAYOUT.progressY}:w=${VIDEO.width}:h=${LAYOUT.progressHeight}:color=white@0.20:t=fill`,
  ];

  const elapsed = (VIDEO.width * scene.startOffset) / totalDuration;
  if (elapsed >= 1) {
    filters.push(
      `drawbox=x=0:y=${LAYOUT.progressY}:w=${Math.round(elapsed)}:` +
        `h=${LAYOUT.progressHeight}:color=${accent}@0.95:t=fill`,
    );
  }

  const steps = Math.ceil(scene.duration / step);
  for (let index = 0; index < steps; index += 1) {
    const from = index * step;
    const x = (VIDEO.width * (scene.startOffset + from)) / totalDuration;
    const width = Math.ceil((VIDEO.width * Math.min(step, scene.duration - from)) / totalDuration);
    if (width < 1) continue;
    filters.push(
      `drawbox=x=${Math.floor(x)}:y=${LAYOUT.progressY}:w=${width}:h=${LAYOUT.progressHeight}:` +
        `color=${accent}@0.95:t=fill:enable='gte(t,${from.toFixed(2)})'`,
    );
  }
  return filters;
}

async function renderScene(
  scene: PreparedScene,
  ctx: SceneContext,
  workDir: string,
  totalDuration: number,
): Promise<string> {
  const bold = fontFileOrThrow("bold");
  const regular = fontFileOrThrow("regular");
  const accent = toFfmpegColor(ctx.plan.accentColor, "#f43f5e");
  const frames = Math.max(2, Math.round(scene.duration * VIDEO.fps));
  const outPath = path.join(workDir, `seg-${String(scene.index).padStart(2, "0")}.mp4`);

  // Zoom alterné : entrant sur les scènes paires, sortant sur les impaires.
  const zoomExpression =
    scene.index % 2 === 0
      ? `min(1+0.12*on/${frames},1.12)`
      : `max(1.12-0.12*on/${frames},1.0)`;

  const chain: string[] = [];

  // Bandeau de marque, en haut à gauche.
  const chipFile = await writeTextFile(workDir, `s${scene.index}-chip.txt`, [
    truncate(ctx.plan.brandName.toUpperCase(), 26),
  ]);
  chain.push(
    drawText({
      textFile: chipFile,
      fontFile: bold,
      fontSize: LAYOUT.chipSize,
      color: "white",
      x: "56",
      y: `${LAYOUT.chipY}`,
      boxColor: `${accent}@0.92`,
      boxPadding: 16,
    }),
  );

  // Compteur d'épisode quand la consigne demande une série.
  if (ctx.videoTotal > 1) {
    const counterFile = await writeTextFile(workDir, `s${scene.index}-counter.txt`, [
      `${ctx.videoIndex}/${ctx.videoTotal}`,
    ]);
    chain.push(
      drawText({
        textFile: counterFile,
        fontFile: bold,
        fontSize: LAYOUT.chipSize,
        color: "white",
        x: `${VIDEO.width}-text_w-56`,
        y: `${LAYOUT.chipY}`,
        boxColor: "black@0.55",
        boxPadding: 16,
      }),
    );
  }

  // Titre incrusté : plus grand sur l'accroche et le call to action.
  if (scene.onScreenText) {
    const isFeature = scene.role !== "body";
    const fontSize = isFeature ? LAYOUT.headlineSize + 12 : LAYOUT.headlineSize;
    const wrapAt = isFeature ? LAYOUT.headlineWrap - 2 : LAYOUT.headlineWrap;
    const headlineFile = await writeTextFile(
      workDir,
      `s${scene.index}-head.txt`,
      wrapText(scene.onScreenText, wrapAt),
    );
    const fadeOut = Math.max(0.3, scene.duration - 0.3);
    chain.push(
      drawText({
        textFile: headlineFile,
        fontFile: bold,
        fontSize,
        color: "white",
        x: "(w-text_w)/2",
        y: scene.role === "cta" ? "(h-text_h)/2-120" : `${LAYOUT.headlineTop}`,
        borderWidth: 6,
        alpha: `if(lt(t,0.32),t/0.32,if(lt(t,${fadeOut.toFixed(2)}),1,max(0,(${scene.duration.toFixed(2)}-t)/0.3)))`,
      }),
    );
  }

  // Sous-titres synchronisés sur la voix off.
  const chunks = chunkForCaptions(scene.narration);
  const spans = distributeDurations(chunks, scene.voiceDuration);
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const span = spans[chunkIndex];
    if (!span) continue;
    const captionFile = await writeTextFile(
      workDir,
      `s${scene.index}-cap${chunkIndex}.txt`,
      wrapText(chunk, LAYOUT.captionWrap),
    );
    const start = PAD_START + span.start;
    const end = chunkIndex === chunks.length - 1 ? scene.duration : PAD_START + span.end;
    chain.push(
      drawText({
        textFile: captionFile,
        fontFile: bold,
        fontSize: LAYOUT.captionSize,
        color: "white",
        x: "(w-text_w)/2",
        y: `${LAYOUT.captionCenterY}-text_h/2`,
        borderWidth: 5,
        enable: `between(t,${start.toFixed(2)},${end.toFixed(2)})`,
      }),
    );
  }

  chain.push(...progressBarFilters(scene, totalDuration, accent));
  chain.push("format=yuv420p");

  // Le zoom d'abord, puis le voile : sinon ses bords se décaleraient avec le zoom.
  const filterComplex =
    `[0:v]zoompan=z='${zoomExpression}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=1:s=${VIDEO.width}x${VIDEO.height}:fps=${VIDEO.fps},setsar=1[zoomed];` +
    `[zoomed][1:v]overlay=0:0:shortest=0[veiled];` +
    `[veiled]${chain.join(",")}[v]`;

  await ffmpeg([
    "-loop",
    "1",
    "-framerate",
    String(VIDEO.fps),
    "-t",
    scene.duration.toFixed(3),
    "-i",
    scene.backgroundPath,
    "-loop",
    "1",
    "-framerate",
    String(VIDEO.fps),
    "-t",
    scene.duration.toFixed(3),
    "-i",
    ctx.scrimPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(VIDEO.fps),
    "-video_track_timescale",
    "30000",
    outPath,
  ]);

  // `regular` n'est pas utilisé pour l'instant, mais on veut échouer tôt s'il manque.
  void regular;
  return outPath;
}

/* ------------------------------------------------------------------ *
 * Piste audio
 * ------------------------------------------------------------------ */

async function buildSceneAudio(scene: PreparedScene, workDir: string): Promise<string> {
  const outPath = path.join(workDir, `aud-${String(scene.index).padStart(2, "0")}.wav`);
  const delayMs = Math.round(PAD_START * 1000);

  if (scene.voicePath) {
    await ffmpeg([
      "-i",
      scene.voicePath,
      "-af",
      `aformat=channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad`,
      "-t",
      scene.duration.toFixed(3),
      "-ar",
      "48000",
      "-ac",
      "2",
      outPath,
    ]);
  } else {
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      scene.duration.toFixed(3),
      "-ar",
      "48000",
      "-ac",
      "2",
      outPath,
    ]);
  }
  return outPath;
}

async function buildAudioTrack(
  scenes: PreparedScene[],
  workDir: string,
  musicPath: string | null,
  totalDuration: number,
): Promise<string> {
  const sceneAudio: string[] = [];
  for (const scene of scenes) {
    sceneAudio.push(await buildSceneAudio(scene, workDir));
  }

  const outPath = path.join(workDir, "audio.m4a");
  const args: string[] = [];
  for (const file of sceneAudio) args.push("-i", file);

  const filters: string[] = [];
  const voiceInputs = sceneAudio.map((_, index) => `[${index}:a]`).join("");
  filters.push(`${voiceInputs}concat=n=${sceneAudio.length}:v=0:a=1[voice]`);

  if (musicPath) {
    args.push("-stream_loop", "-1", "-i", musicPath);
    const musicIndex = sceneAudio.length;
    const fadeStart = Math.max(0, totalDuration - 1.6);
    filters.push(
      `[${musicIndex}:a]aformat=channel_layouts=stereo,volume=0.18,` +
        `atrim=0:${totalDuration.toFixed(3)},asetpts=N/SR/TB,` +
        `afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeStart.toFixed(3)}:d=1.6[music]`,
    );

    if (await hasFilter("sidechaincompress")) {
      // La musique baisse automatiquement dès que la voix parle.
      filters.push("[voice]asplit=2[voiceOut][voiceKey]");
      filters.push(
        "[music][voiceKey]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[ducked]",
      );
      filters.push("[voiceOut][ducked]amix=inputs=2:duration=first:normalize=0[mixed]");
    } else {
      filters.push("[voice][music]amix=inputs=2:duration=first:normalize=0[mixed]");
    }
    filters.push("[mixed]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[out]");
  } else {
    filters.push("[voice]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[out]");
  }

  await ffmpeg([
    ...args,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-t",
    totalDuration.toFixed(3),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    outPath,
  ]);

  return outPath;
}

/* ------------------------------------------------------------------ *
 * Assemblage
 * ------------------------------------------------------------------ */

export async function renderVideo(video: VideoPlan, ctx: RenderContext): Promise<RenderedVideo> {
  const workDir = path.join(ctx.workRoot, video.slug);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(ctx.outDir, { recursive: true });

  ctx.onProgress?.("préparation des scènes");
  const scenes = await prepareScenes(video, ctx, workDir);
  const totalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0);

  const scrimPath = path.join(workDir, "scrim.png");
  await buildScrim(scrimPath);
  const sceneCtx: SceneContext = { ...ctx, scrimPath };

  const segments: string[] = [];
  for (const scene of scenes) {
    ctx.onProgress?.(`rendu scène ${scene.index + 1}/${scenes.length}`);
    segments.push(await renderScene(scene, sceneCtx, workDir, totalDuration));
  }

  ctx.onProgress?.("montage audio");
  const audioPath = await buildAudioTrack(scenes, workDir, ctx.musicPath, totalDuration);

  ctx.onProgress?.("assemblage final");
  const listPath = path.join(workDir, "segments.txt");
  await fs.writeFile(
    listPath,
    segments.map((file) => `file '${path.basename(file).replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8",
  );

  const prefix = String(ctx.videoIndex).padStart(2, "0");
  const videoPath = path.join(ctx.outDir, `${prefix}-${video.slug}.mp4`);
  await ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    videoPath,
  ]);

  const thumbnailPath = path.join(ctx.outDir, `${prefix}-${video.slug}.jpg`);
  await ffmpeg([
    "-ss",
    Math.min(1.2, totalDuration / 3).toFixed(2),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    thumbnailPath,
  ]);

  const hashtags = video.hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
  const description = [
    video.youtubeDescription.trim(),
    "",
    ctx.site.url,
    "",
    hashtags.join(" "),
  ].join("\n");

  const metadataPath = path.join(ctx.outDir, `${prefix}-${video.slug}.json`);
  const duration = await probeDuration(videoPath);
  const metadata = {
    title: truncate(video.youtubeTitle, 100),
    description,
    tags: video.tags,
    hashtags,
    concept: video.concept,
    durationSeconds: Number(duration.toFixed(2)),
    resolution: `${VIDEO.width}x${VIDEO.height}`,
    sourceUrl: ctx.site.url,
    scenes: video.scenes.map((scene, index) => ({
      index,
      narration: scene.narration,
      onScreenText: scene.onScreenText,
      role: scene.role,
      imageUrl: pickImage(ctx.site.images, scene.imageIndex)?.url ?? null,
    })),
  };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    slug: video.slug,
    concept: video.concept,
    videoPath,
    thumbnailPath,
    metadataPath,
    durationSeconds: metadata.durationSeconds,
    youtubeTitle: metadata.title,
    youtubeDescription: description,
    hashtags,
    tags: video.tags,
  };
}
