/**
 * Son des vidéos : voix off et musique de fond.
 *
 * La voix passe par des services de synthèse vocale gratuits et sans compte, dont la
 * réponse est un fichier audio — c'est ce qui permet de l'enregistrer dans la vidéo,
 * là où la lecture vocale intégrée au navigateur reste incapturable.
 *
 * La musique, elle, est fabriquée ici, note par note. Aucun fichier n'est téléchargé,
 * donc aucune question de droits ne se pose sur ce que vous publiez.
 */

import { fetchRemote } from "./scrape.js";

/* ------------------------------------------------------------------ *
 * Voix off
 * ------------------------------------------------------------------ */

const VOICES = {
  fr: ["Celine", "Mathieu", "Lea"],
  en: ["Joanna", "Matthew", "Amy"],
};

/** Services de synthèse vocale, essayés dans l'ordre. Aucun ne demande de compte. */
const SPEECH_SOURCES = [
  {
    id: "streamelements",
    url: (text, lang, voice) =>
      `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}` +
      `&text=${encodeURIComponent(text)}`,
  },
  {
    id: "google",
    url: (text, lang) =>
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob` +
      `&tl=${lang === "fr" ? "fr" : "en"}&q=${encodeURIComponent(text)}`,
  },
];

/** La synthèse vocale limite la longueur : on coupe sur la ponctuation. */
function splitForSpeech(text, maxChars = 180) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let current = "";
  for (const piece of text.split(/(?<=[.!?,;:])\s+/)) {
    if ((current + piece).length > maxChars && current) {
      parts.push(current.trim());
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function concatBuffers(audioContext, buffers) {
  const total = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const channels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels));
  const output = audioContext.createBuffer(channels, total, audioContext.sampleRate);

  let offset = 0;
  for (const buffer of buffers) {
    for (let channel = 0; channel < channels; channel += 1) {
      const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
      output.getChannelData(channel).set(source, offset);
    }
    offset += buffer.length;
  }
  return output;
}

/**
 * Transforme un texte en piste audio. Renvoie `null` si aucun service ne répond :
 * la vidéo garde alors ses sous-titres, elle n'échoue pas pour autant.
 */
export async function speak(audioContext, text, lang = "fr", voiceIndex = 0) {
  const clean = text.trim();
  if (!clean) return null;

  const voice = (VOICES[lang] ?? VOICES.fr)[voiceIndex % 3];
  const chunks = splitForSpeech(clean);

  for (const source of SPEECH_SOURCES) {
    try {
      const buffers = [];
      for (const chunk of chunks) {
        // `sticky: false` : le chemin retenu pour la voix ne doit pas remplacer
        // celui qui fonctionne pour le site et ses images.
        const blob = await fetchRemote(source.url(chunk, lang, voice), {
          as: "blob",
          timeout: 20000,
          sticky: false,
        });
        buffers.push(await audioContext.decodeAudioData(await blob.arrayBuffer()));
      }
      if (buffers.length > 0) return concatBuffers(audioContext, buffers);
    } catch {
      /* service indisponible : on essaie le suivant */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Musique de fond, fabriquée ici
 * ------------------------------------------------------------------ */

const MOODS = {
  calme: { bpm: 72, drums: false, arp: 0.5, pad: 0.34, seventh: true },
  elegant: { bpm: 84, drums: false, arp: 0.7, pad: 0.3, seventh: true },
  energique: { bpm: 104, drums: true, arp: 0.9, pad: 0.24, seventh: false },
};

export const MOOD_NAMES = Object.keys(MOODS);

/** Degrés d'une gamme mineure naturelle, en demi-tons. */
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROGRESSION = [0, 5, 2, 6];

const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function hash(text) {
  let value = 0;
  for (const char of String(text)) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

/** Choisit une ambiance à partir du nom de la marque : stable d'une génération à l'autre. */
export function pickMood(seed) {
  return MOOD_NAMES[hash(seed) % MOOD_NAMES.length];
}

function chordNotes(root, degree, seventh) {
  const scale = (step) => root + MINOR[step % 7] + 12 * Math.floor(step / 7);
  const notes = [scale(degree), scale(degree + 2), scale(degree + 4)];
  if (seventh) notes.push(scale(degree + 6));
  return notes;
}

function envelope(param, start, peak, attack, hold, release) {
  param.setValueAtTime(0.0001, start);
  param.exponentialRampToValueAtTime(peak, start + attack);
  param.setValueAtTime(peak, start + attack + hold);
  param.exponentialRampToValueAtTime(0.0001, start + attack + hold + release);
}

function addNote(context, destination, { midi, start, duration, type, gain, filter }) {
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = midiToHz(midi);

  const amp = context.createGain();
  envelope(amp.gain, start, gain, duration * 0.2, duration * 0.3, duration * 0.5);

  if (filter) {
    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = filter;
    oscillator.connect(lowpass).connect(amp).connect(destination);
  } else {
    oscillator.connect(amp).connect(destination);
  }

  oscillator.start(start);
  oscillator.stop(start + duration + 0.05);
}

function addKick(context, destination, start) {
  const oscillator = context.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(130, start);
  oscillator.frequency.exponentialRampToValueAtTime(45, start + 0.11);

  const amp = context.createGain();
  envelope(amp.gain, start, 0.5, 0.005, 0.02, 0.16);
  oscillator.connect(amp).connect(destination);
  oscillator.start(start);
  oscillator.stop(start + 0.3);
}

function addHat(context, destination, start, noise) {
  const source = context.createBufferSource();
  source.buffer = noise;

  const highpass = context.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 7000;

  const amp = context.createGain();
  envelope(amp.gain, start, 0.07, 0.002, 0.005, 0.05);

  source.connect(highpass).connect(amp).connect(destination);
  source.start(start);
  source.stop(start + 0.12);
}

/**
 * Compose une boucle instrumentale de `seconds` secondes : nappe, arpège, basse,
 * et percussions discrètes selon l'ambiance.
 */
export async function makeMusic(seconds, { mood = "elegant", seed = "vido" } = {}) {
  const settings = MOODS[mood] ?? MOODS.elegant;
  const sampleRate = 44100;
  const length = Math.ceil(seconds * sampleRate);
  const OfflineContext = window.OfflineAudioContext ?? window.webkitOfflineAudioContext;
  const context = new OfflineContext(2, length, sampleRate);

  const master = context.createGain();
  master.gain.value = 0.9;
  const softener = context.createBiquadFilter();
  softener.type = "lowpass";
  softener.frequency.value = 5200;
  master.connect(softener).connect(context.destination);

  // Une seule racine par campagne : les vidéos d'une série restent cohérentes.
  const root = 45 + (hash(seed) % 5); // la grave à do dièse
  const beat = 60 / settings.bpm;
  const bar = beat * 4;

  const noise = context.createBuffer(1, sampleRate * 0.2, sampleRate);
  const noiseData = noise.getChannelData(0);
  for (let i = 0; i < noiseData.length; i += 1) noiseData[i] = Math.random() * 2 - 1;

  for (let index = 0; index * bar < seconds; index += 1) {
    const start = index * bar;
    const degree = PROGRESSION[index % PROGRESSION.length];
    const notes = chordNotes(root + 24, degree, settings.seventh);

    // Nappe : les notes de l'accord tenues sur toute la mesure.
    for (const midi of notes) {
      addNote(context, master, {
        midi,
        start,
        duration: bar * 0.98,
        type: "triangle",
        gain: settings.pad / notes.length,
        filter: 1800,
      });
    }

    // Basse : la fondamentale, deux octaves plus bas.
    addNote(context, master, {
      midi: root + MINOR[degree % 7],
      start,
      duration: bar * 0.9,
      type: "sine",
      gain: 0.26,
    });

    // Arpège : des notes piquées sur les croches.
    for (let step = 0; step < 8; step += 1) {
      const at = start + step * (beat / 2);
      if (at >= seconds) break;
      if (step % 2 === 1 && mood === "calme") continue;
      addNote(context, master, {
        midi: notes[step % notes.length] + 12,
        start: at,
        duration: beat * 0.45,
        type: "sine",
        gain: 0.1 * settings.arp,
        filter: 4200,
      });
    }

    if (settings.drums) {
      for (const position of [0, 2]) addKick(context, master, start + position * beat);
      for (let step = 0; step < 8; step += 1) {
        if (step % 2 === 1) addHat(context, master, start + step * (beat / 2), noise);
      }
    }
  }

  return context.startRendering();
}
