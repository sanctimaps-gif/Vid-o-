import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { config, type TtsProvider } from "../config.js";
import { log } from "../util/log.js";

export interface Speaker {
  readonly name: string;
  /** Écrit la voix off dans `outPath`. Renvoie `null` si le fournisseur ne produit pas d'audio. */
  speak(text: string, outPath: string): Promise<string | null>;
}

class SilentSpeaker implements Speaker {
  readonly name = "aucune voix off";
  async speak(): Promise<string | null> {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * edge-tts : voix neuronales gratuites, via `pipx install edge-tts`
 * ------------------------------------------------------------------ */

function runCommand(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve({ code: -1, stderr: `${bin} introuvable` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

export async function edgeTtsAvailable(): Promise<boolean> {
  const { code } = await runCommand("edge-tts", ["--list-voices"]);
  return code === 0;
}

class EdgeSpeaker implements Speaker {
  readonly name: string;
  constructor(private readonly voice: string) {
    this.name = `edge-tts (${voice})`;
  }

  async speak(text: string, outPath: string): Promise<string | null> {
    if (!text.trim()) return null;
    const { code, stderr } = await runCommand("edge-tts", [
      "--voice",
      this.voice,
      "--text",
      text,
      "--write-media",
      outPath,
    ]);
    if (code !== 0) {
      throw new Error(`edge-tts a échoué : ${stderr.trim() || `code ${code}`}`);
    }
    return outPath;
  }
}

/* ------------------------------------------------------------------ *
 * ElevenLabs
 * ------------------------------------------------------------------ */

class ElevenLabsSpeaker implements Speaker {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly model: string,
  ) {
    this.name = `ElevenLabs (${voiceId})`;
  }

  async speak(text: string, outPath: string): Promise<string | null> {
    if (!text.trim()) return null;
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`ElevenLabs ${response.status} : ${detail.slice(0, 300)}`);
    }
    await fs.writeFile(outPath, Buffer.from(await response.arrayBuffer()));
    return outPath;
  }
}

/* ------------------------------------------------------------------ *
 * Sélection
 * ------------------------------------------------------------------ */

export async function createSpeaker(options: {
  provider?: TtsProvider;
  voice?: string;
}): Promise<Speaker> {
  const provider = options.provider ?? config.tts;

  if (provider === "none") return new SilentSpeaker();

  if (provider === "elevenlabs") {
    if (!config.elevenLabsApiKey || !config.elevenLabsVoiceId) {
      log.warn(
        "ElevenLabs demandé mais ELEVENLABS_API_KEY / VIDO_ELEVENLABS_VOICE_ID manquent : vidéos sans voix off.",
      );
      return new SilentSpeaker();
    }
    return new ElevenLabsSpeaker(
      config.elevenLabsApiKey,
      options.voice || config.elevenLabsVoiceId,
      config.elevenLabsModel,
    );
  }

  if (await edgeTtsAvailable()) {
    return new EdgeSpeaker(options.voice || config.edgeVoice);
  }

  log.warn(
    "edge-tts n'est pas installé (`pipx install edge-tts`) : les vidéos seront muettes, sous-titres compris.",
  );
  return new SilentSpeaker();
}
