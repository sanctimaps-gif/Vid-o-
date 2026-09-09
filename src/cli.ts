#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { generateCampaign } from "./pipeline.js";
import { startServer } from "./server.js";
import { edgeTtsAvailable } from "./tts/index.js";
import { ffmpegVersion, hasFilter } from "./render/ffmpeg.js";
import { log } from "./util/log.js";

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const known = new Set(["generate", "serve", "doctor", "help"]);
  const first = argv[0];
  const command = first && known.has(first) ? first : "generate";
  const rest = first && known.has(first) ? argv.slice(1) : argv;

  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=", 2);
      if (!name) continue;
      if (inline !== undefined) {
        flags.set(name, inline);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(name, next);
          i += 1;
        } else {
          flags.set(name, "true");
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

const HELP = `
Vid-O — génère des Shorts YouTube prêts à poster à partir d'un site web.

  vido "<url du site>" "<consigne>" [options]
  vido generate --url <url> --brief "<consigne>" [options]
  vido serve [--port 4173] [--out ./out]
  vido doctor

Options de génération
  --url <url>        Adresse du site à promouvoir
  --brief <texte>    Consigne, par exemple : "fais 5 vidéos sur les 5 meilleures tenues du magasin"
  --count <n>        Force le nombre de vidéos (sinon déduit de la consigne)
  --out <dossier>    Dossier de sortie (défaut : ./out)
  --tts <edge|elevenlabs|none>   Fournisseur de voix off
  --voice <nom>      Voix à utiliser, par exemple fr-FR-HenriNeural
  --music <dossier>  Dossier de musiques de fond
  --plan <fichier>   Réutilise un plan.json déjà généré (aucun appel au modèle)

Exemple
  vido "https://ma-boutique.fr" "fais découvrir les 5 meilleures tenues du magasin, une vidéo par tenue"
`;

async function commandGenerate(args: Args): Promise<void> {
  const url = args.flags.get("url") ?? args.positional[0];
  const brief = args.flags.get("brief") ?? args.positional.slice(1).join(" ");

  if (!url || !brief) {
    log.error("Il faut une adresse de site et une consigne.");
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const rawCount = Number(args.flags.get("count"));
  const outDir = args.flags.get("out") ?? "out";
  const tts = args.flags.get("tts");

  const started = Date.now();
  const result = await generateCampaign({
    url,
    brief,
    count: Number.isFinite(rawCount) && rawCount > 0 ? Math.round(rawCount) : undefined,
    outDir,
    tts: tts === "edge" || tts === "elevenlabs" || tts === "none" ? tts : undefined,
    voice: args.flags.get("voice"),
    musicDir: args.flags.get("music"),
    planPath: args.flags.get("plan"),
    onProgress: (step, detail) => {
      if (step === "done-video") return;
      log.step(`${step.padEnd(7)} ${detail ?? ""}`.trimEnd());
    },
  });

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log("");
  log.success(`${result.videos.length} vidéo(s) générée(s) en ${seconds}s`);
  for (const video of result.videos) {
    log.info(`${path.basename(video.videoPath)} — ${video.durationSeconds}s — ${video.youtubeTitle}`);
  }
  console.log("");
  log.info(`Dossier : ${result.outDir}`);
  log.info("Titres et descriptions : A-POSTER.md");
}

async function commandDoctor(): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];

  try {
    checks.push(["FFmpeg", true, await ffmpegVersion()]);
    for (const filter of ["zoompan", "drawtext", "gblur", "gradients", "sidechaincompress", "loudnorm"]) {
      const present = await hasFilter(filter);
      checks.push([
        `  filtre ${filter}`,
        present,
        present ? "disponible" : "absent (le rendu bascule sur une solution de repli)",
      ]);
    }
  } catch (error) {
    checks.push(["FFmpeg", false, error instanceof Error ? error.message : String(error)]);
  }

  checks.push([
    "Police grasse",
    Boolean(config.fontBold),
    config.fontBold ?? "aucune police trouvée — installez fonts-dejavu-core ou définissez VIDO_FONT_BOLD",
  ]);
  checks.push([
    "Police normale",
    Boolean(config.fontRegular),
    config.fontRegular ?? "aucune police trouvée — définissez VIDO_FONT_REGULAR",
  ]);

  const hasKey = Boolean(config.anthropicApiKey || process.env.ANTHROPIC_AUTH_TOKEN);
  checks.push(["Clé Anthropic", hasKey, hasKey ? `définie (modèle ${config.model})` : "ANTHROPIC_API_KEY manquante"]);

  if (config.tts === "edge") {
    const edge = await edgeTtsAvailable();
    checks.push(["edge-tts", edge, edge ? `installé (voix ${config.edgeVoice})` : "absent — `pipx install edge-tts`"]);
  } else if (config.tts === "elevenlabs") {
    const ready = Boolean(config.elevenLabsApiKey && config.elevenLabsVoiceId);
    checks.push(["ElevenLabs", ready, ready ? "configuré" : "ELEVENLABS_API_KEY / VIDO_ELEVENLABS_VOICE_ID manquants"]);
  } else {
    checks.push(["Voix off", true, "désactivée (VIDO_TTS=none)"]);
  }

  let musicCount = 0;
  try {
    musicCount = (await fs.readdir(config.musicDir)).filter((entry) =>
      /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(entry),
    ).length;
  } catch {
    musicCount = 0;
  }
  checks.push([
    "Musiques",
    true,
    musicCount > 0 ? `${musicCount} piste(s) dans ${config.musicDir}` : `aucune piste dans ${config.musicDir} (optionnel)`,
  ]);

  console.log("");
  for (const [name, ok, detail] of checks) {
    const mark = ok ? "✓" : "✗";
    console.log(`${mark} ${name.padEnd(18)} ${detail}`);
  }
  console.log("");

  const blocking = checks.filter(([name, ok]) => !ok && !name.startsWith("  filtre"));
  if (blocking.length > 0) {
    log.warn(`${blocking.length} point(s) à corriger avant de générer une campagne.`);
    process.exitCode = 1;
  } else {
    log.success("Tout est prêt.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "serve": {
      const outDir = args.flags.get("out") ?? "out";
      await fs.mkdir(outDir, { recursive: true });
      const port = Number(args.flags.get("port")) || config.port;
      startServer(outDir, port);
      return;
    }
    case "doctor":
      await commandDoctor();
      return;
    case "help":
      console.log(HELP);
      return;
    default:
      if (args.flags.has("help")) {
        console.log(HELP);
        return;
      }
      await commandGenerate(args);
  }
}

main().catch((error: unknown) => {
  console.log("");
  log.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr) {
    console.error(error.stderr.split("\n").slice(-12).join("\n"));
  }
  process.exitCode = 1;
});
