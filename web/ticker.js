/**
 * Horloge de rendu.
 *
 * `requestAnimationFrame` s'arrête net dès que l'onglet passe en arrière-plan : c'est
 * la raison pour laquelle un montage s'interrompait quand on quittait la page. Le
 * minuteur vit donc dans un worker, dont le fil d'exécution est bien moins ralenti
 * qu'un onglet caché — et pas ralenti du tout tant que la page joue du son.
 */

const WORKER_SOURCE = `
let timer = null;
onmessage = (event) => {
  clearInterval(timer);
  timer = null;
  if (event.data && event.data.start) {
    timer = setInterval(() => postMessage(0), event.data.interval);
  }
};
`;

export function createTicker(intervalMs = 32) {
  let worker = null;
  let timer = null;
  let callback = null;

  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => callback?.();
  } catch {
    // Worker interdit par la politique de sécurité : on retombe sur un minuteur simple.
    worker = null;
  }

  return {
    /** `true` quand le minuteur survit à la mise en arrière-plan. */
    backgroundSafe: worker !== null,

    start(fn) {
      callback = fn;
      if (worker) worker.postMessage({ start: true, interval: intervalMs });
      else timer = setInterval(() => callback?.(), intervalMs);
    },

    stop() {
      callback = null;
      if (worker) {
        worker.postMessage({ start: false });
        worker.terminate();
        worker = null;
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Empêcher le téléphone d'endormir la page
 * ------------------------------------------------------------------ */

/**
 * Un son inaudible, joué pendant toute la génération.
 *
 * C'est la pièce qui manquait. Un téléphone met en veille une page qui ne fait
 * rien d'audible : au bout de quelques minutes sans qu'on le touche, l'onglet est
 * suspendu et le montage s'arrête net. Une page qui joue du son, en revanche, est
 * traitée comme un lecteur de musique et reste vivante.
 *
 * Le volume est assez bas pour qu'on n'entende rien, mais le signal n'est pas nul :
 * un silence numérique parfait est parfois compté comme une absence de son, ce qui
 * ferait perdre tout l'intérêt. Ce son ne va qu'aux haut-parleurs, jamais dans la
 * piste enregistrée.
 */
export function keepAudioAwake(audioContext) {
  try {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 40;
    gain.gain.value = 0.0001;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();

    return () => {
      try {
        oscillator.stop();
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        /* déjà arrêté */
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * Le contexte audio est suspendu par le téléphone dès que la page passe derrière.
 * Sans reprise, le son ne repart pas au retour et l'enregistrement reste muet.
 */
export function watchAudioContext(audioContext) {
  const resume = () => {
    if (audioContext.state === "suspended") void audioContext.resume().catch(() => {});
  };
  document.addEventListener("visibilitychange", resume);
  audioContext.addEventListener?.("statechange", resume);
  return () => {
    document.removeEventListener("visibilitychange", resume);
    audioContext.removeEventListener?.("statechange", resume);
  };
}

/* ------------------------------------------------------------------ *
 * Empêcher l'écran de s'éteindre
 * ------------------------------------------------------------------ */

let wakeLock = null;

/** Maintient l'écran allumé pendant le montage, quand le navigateur le permet. */
export async function keepScreenAwake() {
  try {
    if (!navigator.wakeLock) return false;
    wakeLock = await navigator.wakeLock.request("screen");
    // Le verrou saute à chaque passage en arrière-plan : on le reprend au retour.
    wakeLock.addEventListener?.("release", () => {
      wakeLock = null;
    });
    return true;
  } catch {
    return false;
  }
}

export async function releaseScreen() {
  try {
    await wakeLock?.release();
  } catch {
    /* déjà relâché */
  }
  wakeLock = null;
}

export function screenIsAwake() {
  return wakeLock !== null;
}
