/**
 * Montage hors ligne, aussi vite que l'appareil le permet.
 *
 * Le moteur historique enregistre le canvas en direct : une vidéo de vingt-cinq
 * secondes met vingt-cinq secondes à se faire, et pendant tout ce temps la page
 * doit rester éveillée. C'est de là que venaient les interruptions quand on pose
 * le téléphone.
 *
 * Ici, rien n'est joué : les images sont dessinées les unes après les autres et
 * remises à l'encodeur du navigateur, le son est calculé d'un bloc, et le tout est
 * rangé dans un fichier. Une série de cinq vidéos passe de deux minutes à quelques
 * secondes — et ce qui dure quelques secondes ne risque plus la mise en veille.
 *
 * Tout cela repose sur WebCodecs, que tous les navigateurs n'ont pas. Quand il
 * manque, ou quand aucun format commun n'est trouvé, l'appelant revient au moteur
 * en temps réel : le résultat est le même, il prend seulement plus longtemps.
 */

import { assignShots, buildAudio, drawFrame, prepareScenes } from "./render.js";
import { makeMusic } from "./audio.js";

const FPS = 30;
/** Une image-clé toutes les deux secondes : assez pour se déplacer dans la vidéo. */
const KEYFRAME_EVERY = FPS * 2;
const SAMPLE_RATE = 48000;
/** Opus n'accepte que certaines tailles de paquet ; vingt millisecondes est l'usage. */
const PACKET = SAMPLE_RATE / 50;

/** Formats vidéo, du plus souhaitable au moins souhaitable. */
const VIDEO_CODECS = ["vp09.00.10.08", "vp8"];

const CODEC_NAMES = { "vp09.00.10.08": "V_VP9", vp8: "V_VP8" };

/**
 * Le navigateur sait-il encoder sans jouer ? La réponse dépend du format, pas
 * seulement de la présence de l'interface : Safari encode en H.264 mais pas
 * forcément en VP9, et l'inverse est vrai ailleurs.
 */
export async function fastRenderSupported(width, height) {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return null;

  for (const codec of VIDEO_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: width >= 1080 ? 6_000_000 : 3_000_000,
        framerate: FPS,
      });
      if (support?.supported) return codec;
    } catch {
      /* format suivant */
    }
  }
  return null;
}

async function audioSupported() {
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: "opus",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
    return Boolean(support?.supported);
  } catch {
    return false;
  }
}

/** Laisse la main au navigateur : sans cela, la page se fige pendant l'encodage. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Calcule la bande sonore d'un seul tenant, sans la jouer. Le mixage est le même
 * qu'en temps réel — mêmes niveaux, mêmes atténuations sous la voix — mais il est
 * obtenu en une fraction du temps.
 */
async function renderAudio(scenes, music, totalDuration) {
  const frames = Math.ceil((totalDuration + 0.5) * SAMPLE_RATE);
  const offline = new OfflineAudioContext(2, frames, SAMPLE_RATE);

  // Les voix ont été décodées dans le contexte de la page : il faut les recopier
  // dans celui-ci, qui ne connaît pas ses tampons.
  const transplant = (buffer) => {
    if (!buffer) return null;
    const copy = offline.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      copy.copyToChannel(buffer.getChannelData(channel), channel);
    }
    return copy;
  };

  const moved = scenes.map((scene) => ({ ...scene, voice: transplant(scene.voice) }));
  buildAudio(offline, offline.destination, moved, transplant(music), 0, totalDuration, false);

  return offline.startRendering();
}

async function encodeAudio(buffer, onProgress) {
  const chunks = [];
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, timestamp: chunk.timestamp, duration: chunk.duration });
    },
    error: () => {},
  });
  encoder.configure({
    codec: "opus",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 2,
    bitrate: 128_000,
  });

  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

  for (let start = 0; start + PACKET <= buffer.length; start += PACKET) {
    // Opus attend les canaux l'un après l'autre, pas entrelacés.
    const planar = new Float32Array(PACKET * 2);
    planar.set(left.subarray(start, start + PACKET), 0);
    planar.set(right.subarray(start, start + PACKET), PACKET);

    const data = new AudioData({
      format: "f32-planar",
      sampleRate: SAMPLE_RATE,
      numberOfFrames: PACKET,
      numberOfChannels: 2,
      timestamp: Math.round((start / SAMPLE_RATE) * 1e6),
      data: planar,
    });
    encoder.encode(data);
    data.close();

    if (encoder.encodeQueueSize > 40) await breathe();
    onProgress?.(start / buffer.length);
  }

  await encoder.flush();
  encoder.close();
  return chunks;
}

/**
 * Fabrique une vidéo sans la jouer. Rend exactement la même chose que le moteur
 * en temps réel, pour que l'appelant n'ait pas à savoir lequel a travaillé.
 */
export async function renderVideoFast({
  video,
  plan,
  site,
  canvas,
  position,
  total,
  audioContext,
  withVoice = true,
  mood = null,
  musicBuffer = null,
  tour = [],
  codec,
  onProgress,
  onStage,
}) {
  const { writeWebM } = await import("./webm.js");

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

  let music = musicBuffer;
  if (!music && mood) {
    onStage?.("musique");
    try {
      music = await makeMusic(Math.min(totalDuration + 2, 70), { mood, seed: plan.brandName });
    } catch {
      /* sans musique, la vidéo garde la voix et les sous-titres */
    }
  }

  const hero = site.images.find((image) => image.bitmap)?.bitmap ?? null;
  assignShots(scenes, tour, video, position);
  const drawContext = { scenes, plan, site, hero, totalDuration, position, total, W, H };

  // --- Images -------------------------------------------------------
  onStage?.("encodage des images");
  const frames = [];
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        key: chunk.type === "key",
      });
    },
    error: () => {},
  });
  encoder.configure({
    codec,
    width: W,
    height: H,
    bitrate: W >= 1080 ? 6_000_000 : 3_000_000,
    framerate: FPS,
  });

  const count = Math.max(1, Math.round(totalDuration * FPS));
  let thumbnail = null;

  for (let index = 0; index < count; index += 1) {
    const at = index / FPS;
    drawFrame(ctx, drawContext, Math.min(at, totalDuration));
    if (!thumbnail && at > 1.1) thumbnail = canvas.toDataURL("image/jpeg", 0.85);

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(at * 1e6),
      duration: Math.round(1e6 / FPS),
    });
    encoder.encode(frame, { keyFrame: index % KEYFRAME_EVERY === 0 });
    frame.close();

    // La file de l'encodeur ne doit pas enfler sans fin : on la laisse se vider,
    // ce qui rend aussi la main à la page pour qu'elle reste réactive.
    if (encoder.encodeQueueSize > 8 || index % 15 === 0) await breathe();
    onProgress?.((index / count) * 0.8);
  }

  await encoder.flush();
  encoder.close();

  // --- Son ----------------------------------------------------------
  onStage?.("encodage du son");
  let audio = [];
  try {
    const mixed = await renderAudio(scenes, music, totalDuration);
    audio = await encodeAudio(mixed, (ratio) => onProgress?.(0.8 + ratio * 0.18));
  } catch {
    // Une vidéo muette vaut mieux qu'une absence de vidéo.
    audio = [];
  }

  onStage?.("assemblage");
  const blob = writeWebM({
    video: frames,
    audio,
    width: W,
    height: H,
    codec: CODEC_NAMES[codec] ?? "V_VP9",
    sampleRate: SAMPLE_RATE,
    channels: 2,
    durationMs: Math.round(totalDuration * 1000),
  });
  onProgress?.(1);

  return {
    blob,
    extension: "webm",
    thumbnail: thumbnail ?? canvas.toDataURL("image/jpeg", 0.85),
    durationSeconds: Number(totalDuration.toFixed(2)),
    spoken: scenes.some((scene) => scene.voice),
    spokenScenes: scenes.filter((scene) => scene.voice).length,
    totalScenes: scenes.length,
  };
}

/** Les deux conditions réunies : encodeur vidéo utilisable, et son encodable. */
export async function pickFastCodec(width, height) {
  const codec = await fastRenderSupported(width, height);
  if (!codec) return null;
  if (!(await audioSupported())) return null;
  return codec;
}
