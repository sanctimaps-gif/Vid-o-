/**
 * Écriture d'un fichier WebM.
 *
 * L'encodeur du navigateur rend des images et du son déjà compressés, mais rien
 * pour les ranger dans un fichier : c'est le rôle du conteneur, et il n'en existe
 * pas d'intégré. Celui-ci est écrit ici plutôt qu'emprunté à une bibliothèque
 * distante, pour que la page ne dépende d'aucun téléchargement au moment où elle
 * fabrique vos vidéos.
 *
 * WebM est du Matroska : des éléments imbriqués, chacun annoncé par un
 * identifiant puis par sa taille. Tout est assemblé en mémoire avant écriture, ce
 * qui permet d'inscrire les tailles et la durée réelles — un fichier à taille
 * inconnue se lit mal, et beaucoup de lecteurs refusent de s'y déplacer.
 */

/* ------------------------------------------------------------------ *
 * Briques EBML
 * ------------------------------------------------------------------ */

/** Entier de longueur variable, tel que Matroska encode les tailles. */
function vint(value) {
  for (let length = 1; length <= 8; length += 1) {
    const limit = 2 ** (7 * length) - 1;
    if (value < limit) {
      const bytes = new Uint8Array(length);
      let rest = value;
      for (let index = length - 1; index >= 0; index -= 1) {
        bytes[index] = rest & 0xff;
        rest = Math.floor(rest / 256);
      }
      bytes[0] |= 1 << (8 - length);
      return bytes;
    }
  }
  throw new Error("taille trop grande pour ce conteneur");
}

/** Entier non signé, sur le minimum d'octets. */
function uint(value) {
  const bytes = [];
  let rest = Math.max(0, Math.round(value));
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return new Uint8Array(bytes);
}

function float64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return bytes;
}

const utf8 = (text) => new TextEncoder().encode(text);

const toBytes = (id) => {
  const bytes = [];
  let rest = id;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return new Uint8Array(bytes);
};

/** Un élément complet : identifiant, taille, contenu. */
function element(id, payload) {
  const body = payload instanceof Uint8Array ? payload : concat(payload);
  return concat([toBytes(id), vint(body.length), body]);
}

function concat(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Identifiants des éléments utilisés
 * ------------------------------------------------------------------ */

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,

  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,

  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,

  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,

  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,

  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,

  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

/** Durée d'un cluster. Au-delà, l'écart au repère ne tiendrait plus sur deux octets. */
const CLUSTER_MS = 1000;

/**
 * En-tête Opus, tel que le conteneur doit le transporter. Sans lui, le son est
 * illisible : le décodeur ignore le nombre de canaux et le décalage initial.
 */
function opusHead(channels, sampleRate) {
  const head = new Uint8Array(19);
  head.set(utf8("OpusHead"), 0);
  const view = new DataView(head.buffer);
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, 312, true); // pré-décalage, valeur usuelle de l'encodeur
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true); // gain
  head[18] = 0; // famille de correspondance des canaux
  return head;
}

function simpleBlock(track, relativeMs, keyframe, data) {
  const header = new Uint8Array(4);
  header.set(vint(track), 0);
  new DataView(header.buffer).setInt16(1, relativeMs);
  header[3] = keyframe ? 0x80 : 0;
  return element(ID.SimpleBlock, concat([header, data]));
}

/**
 * Assemble le fichier.
 *
 * `video` et `audio` sont des listes de morceaux déjà compressés, chacun avec son
 * instant en microsecondes. Ils sont fusionnés dans l'ordre du temps : un lecteur
 * attend de trouver l'image et le son d'un même instant au même endroit.
 */
export function writeWebM({
  video,
  audio = [],
  width,
  height,
  codec = "V_VP9",
  sampleRate = 48000,
  channels = 2,
  durationMs,
}) {
  if (!video.length) throw new Error("aucune image à écrire");

  const header = element(ID.EBML, [
    element(ID.EBMLVersion, uint(1)),
    element(ID.EBMLReadVersion, uint(1)),
    element(ID.EBMLMaxIDLength, uint(4)),
    element(ID.EBMLMaxSizeLength, uint(8)),
    element(ID.DocType, utf8("webm")),
    element(ID.DocTypeVersion, uint(2)),
    element(ID.DocTypeReadVersion, uint(2)),
  ]);

  const total =
    durationMs ??
    Math.ceil(Math.max(...video.map((chunk) => (chunk.timestamp + (chunk.duration ?? 0)) / 1000)));

  const info = element(ID.Info, [
    // Les instants seront exprimés en millisecondes.
    element(ID.TimecodeScale, uint(1_000_000)),
    element(ID.MuxingApp, utf8("Vid-O")),
    element(ID.WritingApp, utf8("Vid-O")),
    element(ID.Duration, float64(total)),
  ]);

  const trackEntries = [
    element(ID.TrackEntry, [
      element(ID.TrackNumber, uint(VIDEO_TRACK)),
      element(ID.TrackUID, uint(VIDEO_TRACK)),
      element(ID.TrackType, uint(1)),
      element(ID.FlagLacing, uint(0)),
      element(ID.CodecID, utf8(codec)),
      element(ID.Video, [element(ID.PixelWidth, uint(width)), element(ID.PixelHeight, uint(height))]),
    ]),
  ];

  if (audio.length > 0) {
    trackEntries.push(
      element(ID.TrackEntry, [
        element(ID.TrackNumber, uint(AUDIO_TRACK)),
        element(ID.TrackUID, uint(AUDIO_TRACK)),
        element(ID.TrackType, uint(2)),
        element(ID.FlagLacing, uint(0)),
        element(ID.CodecID, utf8("A_OPUS")),
        element(ID.CodecPrivate, opusHead(channels, sampleRate)),
        element(ID.Audio, [
          element(ID.SamplingFrequency, float64(sampleRate)),
          element(ID.Channels, uint(channels)),
        ]),
      ]),
    );
  }

  const tracks = element(ID.Tracks, trackEntries);

  // Les deux pistes sont fusionnées dans l'ordre du temps.
  const timeline = [
    ...video.map((chunk) => ({ ...chunk, track: VIDEO_TRACK })),
    ...audio.map((chunk) => ({ ...chunk, track: AUDIO_TRACK, key: true })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  const clusters = [];
  const cues = [];
  let current = null;
  let currentStart = 0;
  // Un repère pointe une position comptée depuis le début des données du Segment,
  // pas depuis le premier cluster : ce qui précède en fait partie.
  let position = info.length + tracks.length;

  const flush = () => {
    if (!current) return;
    const bytes = element(ID.Cluster, [element(ID.Timecode, uint(currentStart)), ...current]);
    clusters.push(bytes);
    position += bytes.length;
  };

  for (const chunk of timeline) {
    const atMs = Math.round(chunk.timestamp / 1000);
    const needsCluster = !current || (chunk.track === VIDEO_TRACK && chunk.key && atMs - currentStart >= CLUSTER_MS);

    if (needsCluster) {
      flush();
      current = [];
      currentStart = atMs;
      if (chunk.track === VIDEO_TRACK) {
        cues.push(
          element(ID.CuePoint, [
            element(ID.CueTime, uint(atMs)),
            element(ID.CueTrackPositions, [
              element(ID.CueTrack, uint(VIDEO_TRACK)),
              element(ID.CueClusterPosition, uint(position)),
            ]),
          ]),
        );
      }
    }

    current.push(simpleBlock(chunk.track, atMs - currentStart, chunk.key, chunk.data));
  }
  flush();

  const segment = element(ID.Segment, [info, tracks, ...clusters, element(ID.Cues, cues)]);
  return new Blob([header, segment], { type: "video/webm" });
}
