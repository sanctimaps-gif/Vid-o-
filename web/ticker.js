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
