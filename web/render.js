/**
 * Montage vidéo dans le navigateur.
 *
 * Le rendu se fait image par image dans un <canvas>, capturé en direct par MediaRecorder.
 * L'enregistrement est donc en temps réel : une vidéo de 25 secondes met 25 secondes à se
 * fabriquer, et l'utilisateur la voit se construire pendant ce temps.
 */

import { normalize } from "./writer.js";

const PAD_START = 0.25;
const PAD_END = 0.5;
const MIN_SCENE = 2.4;
const MAX_SCENE = 10;

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * L'extension est déduite des premiers octets du fichier, pas du format demandé :
 * un navigateur peut très bien livrer autre chose que ce qu'on lui a réclamé.
 */
async function sniffExtension(blob, requested) {
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
    const tag = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (tag === "ftyp") return "mp4";
  } catch {
    /* lecture impossible : on retombe sur le format demandé */
  }
  return requested.includes("mp4") ? "mp4" : "webm";
}

/** Format d'enregistrement retenu selon ce que le navigateur sait produire. */
export function pickMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function isSupported() {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickMimeType() !== ""
  );
}

function estimateSpeechSeconds(text) {
  const words = normalize(text).split(/\s+/).filter(Boolean).length;
  return Math.max(1.8, words / 2.6);
}

function chunkForCaptions(narration, maxWords = 4) {
  const clean = normalize(narration);
  if (!clean) return [];
  const chunks = [];
  for (const segment of clean.split(/(?<=[.!?,;:])\s+/).filter(Boolean)) {
    const words = segment.split(/\s+/);
    for (let i = 0; i < words.length; i += maxWords) {
      const chunk = words.slice(i, i + maxWords).join(" ");
      const previous = chunks[chunks.length - 1];
      if (chunk.split(" ").length === 1 && previous) chunks[chunks.length - 1] = `${previous} ${chunk}`;
      else chunks.push(chunk);
    }
  }
  return chunks.map((chunk) => chunk.replace(/[.,;:]$/, ""));
}

function distribute(chunks, total) {
  const weights = chunks.map((chunk) => Math.max(chunk.length, 6));
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  let cursor = 0;
  return chunks.map((_, index) => {
    const end = index === chunks.length - 1 ? total : cursor + (weights[index] / sum) * total;
    const span = { start: cursor, end };
    cursor = end;
    return span;
  });
}

/** Découpe un texte en lignes qui tiennent dans `maxWidth`, en mesurant réellement la police. */
function wrapLines(ctx, text, maxWidth) {
  const words = normalize(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawWrapped(ctx, text, { x, y, maxWidth, lineHeight, align = "center" }) {
  const lines = wrapLines(ctx, text, maxWidth);
  ctx.textAlign = align;
  lines.forEach((line, index) => {
    const lineY = y + index * lineHeight;
    if (ctx.lineWidth > 0) ctx.strokeText(line, x, lineY);
    ctx.fillText(line, x, lineY);
  });
  return lines.length * lineHeight;
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  ctx.fill();
}

/** Prépare les scènes : durées, décalages, visuel associé. */
export function prepareScenes(video, site) {
  let offset = 0;
  return video.scenes.map((scene, index) => {
    const narration = normalize(scene.narration);
    const spoken = estimateSpeechSeconds(narration);
    const duration = Math.min(MAX_SCENE, Math.max(MIN_SCENE, spoken + PAD_START + PAD_END));
    const image = site.images.find((candidate) => candidate.index === scene.imageIndex && candidate.bitmap);

    const prepared = {
      index,
      narration,
      onScreenText: normalize(scene.onScreenText),
      role: scene.role,
      bitmap: image?.bitmap ?? null,
      duration,
      spoken,
      start: offset,
      captions: [],
    };
    const chunks = chunkForCaptions(narration);
    prepared.captions = distribute(chunks, spoken).map((span, position) => ({
      text: chunks[position],
      start: PAD_START + span.start,
      end: position === chunks.length - 1 ? duration : PAD_START + span.end,
    }));

    offset += duration;
    return prepared;
  });
}

/* ------------------------------------------------------------------ *
 * Dessin d'une image de la vidéo
 * ------------------------------------------------------------------ */

function drawBackground(ctx, scene, plan, progress, W, H) {
  // Zoom alterné : entrant sur les scènes paires, sortant sur les impaires.
  const zoom = scene.index % 2 === 0 ? 1 + 0.12 * progress : 1.12 - 0.12 * progress;

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -H / 2);

  if (scene.bitmap) {
    const { width: iw, height: ih } = scene.bitmap;

    // Arrière-plan : la photo recadrée plein cadre et floutée.
    const cover = Math.max(W / iw, H / ih);
    ctx.save();
    if (ctx.filter !== undefined) ctx.filter = "blur(48px) brightness(0.55) saturate(1.2)";
    ctx.drawImage(scene.bitmap, (W - iw * cover) / 2, (H - ih * cover) / 2, iw * cover, ih * cover);
    ctx.restore();
    if (ctx.filter === undefined) {
      // Navigateur sans filtre canvas : on assombrit à la place, le texte reste lisible.
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, W, H);
    }

    // Premier plan : la photo entière, jamais rognée.
    const contain = Math.min((W * 0.94) / iw, (H * 0.66) / ih);
    ctx.drawImage(
      scene.bitmap,
      (W - iw * contain) / 2,
      (H - ih * contain) / 2 - H * 0.055,
      iw * contain,
      ih * contain,
    );
  } else {
    // Fond de marque : un dégradé sombre, plus une lueur d'accent discrète en haut de cadre.
    const base = ctx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, plan.backgroundColor);
    base.addColorStop(1, "#070b14");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(W / 2, H * 0.32, 0, W / 2, H * 0.32, W * 0.85);
    glow.addColorStop(0, plan.accentColor);
    glow.addColorStop(1, "transparent");
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  ctx.restore();
}

function drawScrim(ctx, W, H) {
  const top = ctx.createLinearGradient(0, 0, 0, H * 0.25);
  top.addColorStop(0, "rgba(0,0,0,0.58)");
  top.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, H * 0.25);

  const bottom = ctx.createLinearGradient(0, H * 0.59, 0, H);
  bottom.addColorStop(0, "rgba(0,0,0,0)");
  bottom.addColorStop(1, "rgba(0,0,0,0.72)");
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H * 0.59, W, H * 0.41);
}

function drawChips(ctx, plan, position, total, W, H) {
  const scale = W / 1080;
  const size = 34 * scale;
  ctx.font = `700 ${size}px ${FONT_STACK}`;
  ctx.textBaseline = "middle";

  const label = normalize(plan.brandName).toUpperCase().slice(0, 26);
  const width = ctx.measureText(label).width + 34 * scale;
  ctx.fillStyle = plan.accentColor;
  roundedRect(ctx, 52 * scale, 78 * scale, width, 62 * scale, 12 * scale);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.fillText(label, 69 * scale, 110 * scale);

  if (total > 1) {
    const counter = `${position}/${total}`;
    const counterWidth = ctx.measureText(counter).width + 34 * scale;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundedRect(ctx, W - 52 * scale - counterWidth, 78 * scale, counterWidth, 62 * scale, 12 * scale);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(counter, W - 52 * scale - counterWidth / 2, 110 * scale);
  }
}

function drawProgress(ctx, elapsed, total, plan, W, H) {
  const scale = W / 1080;
  const height = 10 * scale;
  const y = H - 42 * scale;
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(0, y, W, height);
  ctx.fillStyle = plan.accentColor;
  ctx.fillRect(0, y, W * Math.min(1, elapsed / total), height);
}

export function drawFrame(ctx, scenes, plan, elapsed, totalDuration, position, total, W, H) {
  const scene = scenes.find((item) => elapsed < item.start + item.duration) ?? scenes[scenes.length - 1];
  const local = Math.max(0, Math.min(scene.duration, elapsed - scene.start));
  const progress = local / scene.duration;
  const scale = W / 1080;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  drawBackground(ctx, scene, plan, progress, W, H);
  drawScrim(ctx, W, H);
  drawChips(ctx, plan, position, total, W, H);

  ctx.textBaseline = "alphabetic";
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineJoin = "round";

  // Titre incrusté, en fondu au début et à la fin de la scène.
  if (scene.onScreenText) {
    const feature = scene.role !== "body";
    const fontSize = (feature ? 88 : 76) * scale;
    ctx.font = `800 ${fontSize}px ${FONT_STACK}`;
    ctx.lineWidth = 8 * scale;
    const alpha =
      local < 0.32 ? local / 0.32 : Math.min(1, Math.max(0, (scene.duration - local) / 0.3));
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.fillStyle = "#fff";
    drawWrapped(ctx, scene.onScreenText, {
      x: W / 2,
      y: scene.role === "cta" ? H * 0.46 : 300 * scale,
      maxWidth: W * 0.86,
      lineHeight: fontSize * 1.14,
    });
    ctx.globalAlpha = 1;
  }

  // Sous-titres, calés sur le rythme estimé de la narration.
  const caption = scene.captions.find((item) => local >= item.start && local < item.end);
  if (caption) {
    const fontSize = 56 * scale;
    ctx.font = `700 ${fontSize}px ${FONT_STACK}`;
    ctx.lineWidth = 7 * scale;
    ctx.fillStyle = "#fff";
    const lines = wrapLines(ctx, caption.text, W * 0.84).length;
    drawWrapped(ctx, caption.text, {
      x: W / 2,
      y: H * 0.745 - ((lines - 1) * fontSize * 1.16) / 2,
      maxWidth: W * 0.84,
      lineHeight: fontSize * 1.16,
    });
  }

  ctx.lineWidth = 0;
  drawProgress(ctx, elapsed, totalDuration, plan, W, H);
}

/* ------------------------------------------------------------------ *
 * Enregistrement
 * ------------------------------------------------------------------ */

/**
 * Fabrique une vidéo et renvoie le fichier, la miniature et sa durée.
 * `music` est un AudioBuffer facultatif, mixé en fond sonore.
 */
export async function renderVideo({
  video,
  plan,
  site,
  canvas,
  position,
  total,
  music = null,
  onProgress,
}) {
  const scenes = prepareScenes(video, site);
  const totalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext("2d", { alpha: false });

  const stream = canvas.captureStream(30);
  let audioContext = null;

  if (music) {
    audioContext = new (window.AudioContext ?? window.webkitAudioContext)();
    const source = audioContext.createBufferSource();
    source.buffer = music;
    source.loop = true;
    const gain = audioContext.createGain();
    gain.gain.value = 0.22;
    const destination = audioContext.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(destination);
    // Fondu de sortie sur la fin de la vidéo.
    gain.gain.setValueAtTime(0.22, audioContext.currentTime + Math.max(0, totalDuration - 1.5));
    gain.gain.linearRampToValueAtTime(0, audioContext.currentTime + totalDuration);
    source.start();
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: W >= 1080 ? 8_000_000 : 4_000_000,
  });
  const parts = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) parts.push(event.data);
  };

  const finished = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });

  let thumbnail = null;
  recorder.start(250);
  const startedAt = performance.now();

  await new Promise((resolve) => {
    const step = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      drawFrame(ctx, scenes, plan, Math.min(elapsed, totalDuration), totalDuration, position, total, W, H);

      if (!thumbnail && elapsed > 1.1) {
        thumbnail = canvas.toDataURL("image/jpeg", 0.85);
      }
      onProgress?.(Math.min(1, elapsed / totalDuration));

      if (elapsed >= totalDuration) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  recorder.stop();
  await finished;
  for (const track of stream.getTracks()) track.stop();
  if (audioContext) await audioContext.close();

  const blob = new Blob(parts, { type: mimeType });
  return {
    blob,
    extension: await sniffExtension(blob, mimeType),
    thumbnail: thumbnail ?? canvas.toDataURL("image/jpeg", 0.85),
    durationSeconds: Number(totalDuration.toFixed(2)),
  };
}
