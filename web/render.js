/**
 * Montage vidéo dans le navigateur.
 *
 * Le rendu se fait image par image dans un <canvas>, capturé en direct par MediaRecorder,
 * pendant que la voix off et la musique sont jouées dans le même temps par WebAudio.
 * L'enregistrement est donc en temps réel : une vidéo de 25 secondes met 25 secondes à
 * se fabriquer, et on la voit se construire.
 */

import { normalize } from "./writer.js";
import { makeMusic, pickMood, speak } from "./audio.js";
import { createTicker } from "./ticker.js";

const PAD_START = 0.3;
const PAD_END = 0.55;
const MIN_SCENE = 2.4;
const MAX_SCENE = 11;

const MUSIC_LEVEL = 0.22;
const MUSIC_DUCKED = 0.07;

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

function roundedPath(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function roundedRect(ctx, x, y, width, height, radius) {
  roundedPath(ctx, x, y, width, height, radius);
  ctx.fill();
}

/* ------------------------------------------------------------------ *
 * Préparation : voix off, durées, sous-titres
 * ------------------------------------------------------------------ */

export async function prepareScenes(video, site, options) {
  const { audioContext, withVoice, lang, voiceIndex = 0, onProgress } = options;
  const prepared = [];
  let offset = 0;

  for (const [index, scene] of video.scenes.entries()) {
    const narration = normalize(scene.narration);

    let voice = null;
    if (withVoice && narration) {
      onProgress?.(`voix ${index + 1}/${video.scenes.length}`);
      voice = await speak(audioContext, narration, lang, voiceIndex);
    }

    // La durée suit la voix réelle quand il y en a une : les sous-titres tombent juste.
    const spoken = voice ? voice.duration : estimateSpeechSeconds(narration);
    const duration = Math.min(MAX_SCENE, Math.max(MIN_SCENE, spoken + PAD_START + PAD_END));
    const image = site.images.find((candidate) => candidate.index === scene.imageIndex && candidate.bitmap);

    const chunks = chunkForCaptions(narration);
    prepared.push({
      index,
      narration,
      onScreenText: normalize(scene.onScreenText),
      role: scene.role,
      bitmap: image?.bitmap ?? null,
      voice,
      duration,
      spoken,
      start: offset,
      captions: distribute(chunks, spoken).map((span, position) => ({
        text: chunks[position],
        start: PAD_START + span.start,
        end: position === chunks.length - 1 ? duration : PAD_START + span.end,
      })),
    });
    offset += duration;
  }

  return prepared;
}

/* ------------------------------------------------------------------ *
 * Le site à l'écran
 * ------------------------------------------------------------------ */

/**
 * Fenêtre de navigateur affichant la vraie page : capture d'écran quand elle est
 * disponible, sinon une page reconstituée avec le visuel et les textes du site.
 * C'est ce plan qui donne la sensation d'entrer dans le site.
 */
function drawSiteWindow(ctx, { screenshot, site, plan, progress, W, H, hero }) {
  const scale = W / 1080;
  const frameX = 64 * scale;
  // La fenêtre laisse la place au titre incrusté au-dessus d'elle.
  const frameY = H * 0.215;
  const frameW = W - frameX * 2;
  const frameH = H * 0.5;
  const radius = 30 * scale;
  const barH = 74 * scale;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 48 * scale;
  ctx.shadowOffsetY = 18 * scale;
  ctx.fillStyle = "#0d1220";
  roundedRect(ctx, frameX, frameY, frameW, frameH, radius);
  ctx.restore();

  // Barre d'adresse : le nom de domaine, comme dans un vrai navigateur.
  ctx.save();
  roundedPath(ctx, frameX, frameY, frameW, barH + radius, radius);
  ctx.clip();
  ctx.fillStyle = "#1b2436";
  ctx.fillRect(frameX, frameY, frameW, barH + radius);
  ctx.restore();

  const dotY = frameY + barH / 2;
  ["#ff5f57", "#febc2e", "#28c840"].forEach((color, position) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(frameX + (34 + position * 26) * scale, dotY, 8 * scale, 0, Math.PI * 2);
    ctx.fill();
  });

  const pillX = frameX + 130 * scale;
  const pillW = frameW - 170 * scale;
  ctx.fillStyle = "#0d1220";
  roundedRect(ctx, pillX, dotY - 22 * scale, pillW, 44 * scale, 22 * scale);
  ctx.fillStyle = "#93a3c4";
  ctx.font = `600 ${26 * scale}px ${FONT_STACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(site.domain, pillX + 22 * scale, dotY);

  // Contenu de la page, qui défile lentement.
  const pageY = frameY + barH;
  const pageH = frameH - barH;
  ctx.save();
  roundedPath(ctx, frameX, pageY, frameW, pageH, 4);
  ctx.clip();
  ctx.fillStyle = "#f7f8fb";
  ctx.fillRect(frameX, pageY, frameW, pageH);

  if (screenshot) {
    const drawW = frameW;
    const drawH = (screenshot.height / screenshot.width) * drawW;
    const travel = Math.max(0, drawH - pageH);
    ctx.drawImage(screenshot, frameX, pageY - travel * progress, drawW, drawH);
  } else {
    // Page reconstituée : le visuel du site, son titre, sa description.
    const heroH = pageH * 0.52;
    if (hero) {
      const cover = Math.max(frameW / hero.width, heroH / hero.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(frameX, pageY, frameW, heroH);
      ctx.clip();
      ctx.drawImage(
        hero,
        frameX + (frameW - hero.width * cover) / 2,
        pageY + (heroH - hero.height * cover) / 2 - progress * 24 * scale,
        hero.width * cover,
        hero.height * cover,
      );
      ctx.restore();
    } else {
      ctx.fillStyle = plan.accentColor;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(frameX, pageY, frameW, heroH);
      ctx.globalAlpha = 1;
    }

    const textX = frameX + 34 * scale;
    let cursor = pageY + heroH + 56 * scale - progress * 40 * scale;

    ctx.fillStyle = "#101828";
    ctx.font = `800 ${40 * scale}px ${FONT_STACK}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.lineWidth = 0;
    for (const line of wrapLines(ctx, site.siteName, frameW - 68 * scale).slice(0, 2)) {
      ctx.fillText(line, textX, cursor);
      cursor += 46 * scale;
    }

    cursor += 12 * scale;
    ctx.fillStyle = "#475467";
    ctx.font = `400 ${27 * scale}px ${FONT_STACK}`;
    const pitch = site.description || site.title || "";
    for (const line of wrapLines(ctx, pitch, frameW - 68 * scale).slice(0, 3)) {
      ctx.fillText(line, textX, cursor);
      cursor += 36 * scale;
    }

    // Quelques blocs gris : la page continue sous le pli.
    ctx.fillStyle = "#e4e7ec";
    for (let row = 0; row < 3; row += 1) {
      const y = cursor + (18 + row * 26) * scale;
      if (y > pageY + pageH) break;
      roundedRect(ctx, textX, y, (frameW - 68 * scale) * (row === 2 ? 0.55 : 1), 12 * scale, 6 * scale);
    }
  }
  ctx.restore();

  // Dégradé en bas de la fenêtre : la page paraît se prolonger.
  const fade = ctx.createLinearGradient(0, pageY + pageH - 70 * scale, 0, pageY + pageH);
  fade.addColorStop(0, "rgba(13,18,32,0)");
  fade.addColorStop(1, "rgba(13,18,32,0.75)");
  ctx.fillStyle = fade;
  ctx.fillRect(frameX, pageY + pageH - 70 * scale, frameW, 70 * scale);
}

function drawPhoto(ctx, bitmap, zoom, W, H) {
  const { width: iw, height: ih } = bitmap;

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -H / 2);

  const cover = Math.max(W / iw, H / ih);
  ctx.save();
  if (ctx.filter !== undefined) ctx.filter = "blur(48px) brightness(0.55) saturate(1.2)";
  ctx.drawImage(bitmap, (W - iw * cover) / 2, (H - ih * cover) / 2, iw * cover, ih * cover);
  ctx.restore();
  if (ctx.filter === undefined) {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, W, H);
  }

  const contain = Math.min((W * 0.94) / iw, (H * 0.66) / ih);
  ctx.drawImage(
    bitmap,
    (W - iw * contain) / 2,
    (H - ih * contain) / 2 - H * 0.055,
    iw * contain,
    ih * contain,
  );
  ctx.restore();
}

function drawBrandBackdrop(ctx, plan, W, H) {
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

function drawChips(ctx, plan, site, position, total, W) {
  const scale = W / 1080;
  const size = 32 * scale;
  ctx.font = `700 ${size}px ${FONT_STACK}`;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 0;

  // Le nom de domaine reste affiché : on sait en permanence où l'on est.
  const label = site.domain.toUpperCase().slice(0, 28);
  const width = ctx.measureText(label).width + 34 * scale;
  ctx.fillStyle = plan.accentColor;
  roundedRect(ctx, 52 * scale, 74 * scale, width, 58 * scale, 14 * scale);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.fillText(label, 69 * scale, 103 * scale);

  if (total > 1) {
    const counter = `${position}/${total}`;
    const counterWidth = ctx.measureText(counter).width + 34 * scale;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundedRect(ctx, W - 52 * scale - counterWidth, 74 * scale, counterWidth, 58 * scale, 14 * scale);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(counter, W - 52 * scale - counterWidth / 2, 103 * scale);
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

export function drawFrame(ctx, context, elapsed) {
  const { scenes, plan, site, screenshot, hero, totalDuration, position, total, W, H } = context;
  const scene = scenes.find((item) => elapsed < item.start + item.duration) ?? scenes[scenes.length - 1];
  const local = Math.max(0, Math.min(scene.duration, elapsed - scene.start));
  const progress = local / scene.duration;
  const scale = W / 1080;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  // L'ouverture et la conclusion montrent le site lui-même ; entre les deux,
  // ses visuels occupent tout le cadre.
  const asWindow = scene.role !== "body" || (!scene.bitmap && (screenshot || hero));

  if (asWindow) {
    if (screenshot) {
      drawPhoto(ctx, screenshot, 1.06, W, H);
      ctx.fillStyle = "rgba(6,10,20,0.55)";
      ctx.fillRect(0, 0, W, H);
    } else {
      drawBrandBackdrop(ctx, plan, W, H);
    }
    drawSiteWindow(ctx, { screenshot, site, plan, progress, W, H, hero });
  } else if (scene.bitmap) {
    drawPhoto(ctx, scene.bitmap, scene.index % 2 === 0 ? 1 + 0.12 * progress : 1.12 - 0.12 * progress, W, H);
  } else {
    drawBrandBackdrop(ctx, plan, W, H);
  }

  drawScrim(ctx, W, H);
  drawChips(ctx, plan, site, position, total, W);

  ctx.textBaseline = "alphabetic";
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineJoin = "round";

  if (scene.onScreenText) {
    const feature = scene.role !== "body";
    const fontSize = (feature ? 82 : 76) * scale;
    ctx.font = `800 ${fontSize}px ${FONT_STACK}`;
    ctx.lineWidth = 8 * scale;
    const alpha = local < 0.32 ? local / 0.32 : Math.min(1, Math.max(0, (scene.duration - local) / 0.3));
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.fillStyle = "#fff";
    drawWrapped(ctx, scene.onScreenText, {
      x: W / 2,
      y: asWindow ? H * 0.105 : 300 * scale,
      maxWidth: W * 0.86,
      lineHeight: fontSize * 1.14,
    });
    ctx.globalAlpha = 1;
  }

  const caption = scene.captions.find((item) => local >= item.start && local < item.end);
  if (caption) {
    const fontSize = 56 * scale;
    ctx.font = `700 ${fontSize}px ${FONT_STACK}`;
    ctx.lineWidth = 7 * scale;
    ctx.fillStyle = "#fff";
    const lines = wrapLines(ctx, caption.text, W * 0.84).length;
    drawWrapped(ctx, caption.text, {
      x: W / 2,
      y: H * 0.79 - ((lines - 1) * fontSize * 1.16) / 2,
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

/** Construit la piste sonore : voix aux bons instants, musique atténuée dessous. */
function buildAudio(audioContext, destination, scenes, music, startAt, totalDuration) {
  const monitor = audioContext.destination;

  if (music) {
    const source = audioContext.createBufferSource();
    source.buffer = music;
    source.loop = true;

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(MUSIC_LEVEL, startAt + 1.2);

    // La musique s'efface sous chaque phrase, puis revient.
    for (const scene of scenes) {
      if (!scene.voice) continue;
      const from = startAt + scene.start + PAD_START;
      const to = from + scene.voice.duration;
      gain.gain.setTargetAtTime(MUSIC_DUCKED, from - 0.25, 0.12);
      gain.gain.setTargetAtTime(MUSIC_LEVEL, to + 0.1, 0.3);
    }
    gain.gain.setTargetAtTime(0.0001, startAt + totalDuration - 1.2, 0.35);

    source.connect(gain);
    gain.connect(destination);
    gain.connect(monitor);
    source.start(startAt);
    source.stop(startAt + totalDuration + 0.4);
  }

  for (const scene of scenes) {
    if (!scene.voice) continue;
    const source = audioContext.createBufferSource();
    source.buffer = scene.voice;

    const gain = audioContext.createGain();
    gain.gain.value = 1.15;
    source.connect(gain);
    gain.connect(destination);
    gain.connect(monitor);
    source.start(startAt + scene.start + PAD_START);
  }
}

/**
 * Fabrique une vidéo et renvoie le fichier, la miniature et sa durée.
 */
export async function renderVideo({
  video,
  plan,
  site,
  canvas,
  position,
  total,
  audioContext,
  withVoice = true,
  mood,
  screenshot = null,
  onProgress,
  onStage,
}) {
  const lang = plan.language === "en" ? "en" : "fr";
  const scenes = await prepareScenes(video, site, {
    audioContext,
    withVoice,
    lang,
    voiceIndex: 0,
    onProgress: onStage,
  });

  const totalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext("2d", { alpha: false });

  onStage?.("musique");
  let music = null;
  try {
    music = await makeMusic(Math.min(totalDuration + 2, 70), {
      mood: mood ?? pickMood(plan.brandName),
      seed: plan.brandName,
    });
  } catch {
    /* sans musique, la vidéo garde la voix et les sous-titres */
  }

  const hero = site.images.find((image) => image.bitmap)?.bitmap ?? null;

  // Avec `captureStream(0)`, aucune image n'est prélevée automatiquement : c'est nous
  // qui poussons chaque image dessinée. Le montage ne dépend donc plus de l'affichage
  // de la page, et continue quand l'onglet passe derrière.
  const manual =
    typeof canvas.captureStream === "function" &&
    typeof canvas.captureStream(0).getVideoTracks()[0]?.requestFrame === "function";
  const stream = canvas.captureStream(manual ? 0 : 30);
  const videoTrack = stream.getVideoTracks()[0];

  const destination = audioContext.createMediaStreamDestination();
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

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

  onStage?.("enregistrement");
  if (audioContext.state === "suspended") await audioContext.resume();

  const lead = 0.25;
  const startAt = audioContext.currentTime + lead;
  buildAudio(audioContext, destination, scenes, music, startAt, totalDuration);

  recorder.start(250);
  const startedAt = performance.now() + lead * 1000;

  const drawContext = { scenes, plan, site, screenshot, hero, totalDuration, position, total, W, H };
  let thumbnail = null;
  const ticker = createTicker(1000 / 30);

  await new Promise((resolve) => {
    let done = false;
    const step = () => {
      if (done) return;
      // L'image dessinée suit l'horloge réelle, celle que suit aussi le son : une
      // interruption coûte des images, jamais le synchronisme avec la voix.
      const elapsed = Math.max(0, (performance.now() - startedAt) / 1000);
      drawFrame(ctx, drawContext, Math.min(elapsed, totalDuration));
      if (manual) videoTrack.requestFrame();

      if (!thumbnail && elapsed > 1.1) thumbnail = canvas.toDataURL("image/jpeg", 0.85);
      onProgress?.(Math.min(1, elapsed / totalDuration));

      if (elapsed >= totalDuration) {
        done = true;
        ticker.stop();
        resolve();
      }
    };
    ticker.start(step);
  });

  recorder.stop();
  await finished;
  for (const track of stream.getTracks()) track.stop();

  const blob = new Blob(parts, { type: mimeType });
  return {
    blob,
    extension: await sniffExtension(blob, mimeType),
    thumbnail: thumbnail ?? canvas.toDataURL("image/jpeg", 0.85),
    durationSeconds: Number(totalDuration.toFixed(2)),
    spoken: scenes.some((scene) => scene.voice),
  };
}
