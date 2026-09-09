import { z } from "zod";
import { CampaignPlanSchema, type CampaignPlan } from "../../types.js";
import { SYSTEM_PROMPT, buildUserMessage, type PlanOptions, type Writer } from "../prompt.js";

/**
 * Rédacteur pour toute API compatible OpenAI : Ollama en local, ou un palier gratuit en ligne
 * (Groq, OpenRouter, Google AI Studio, Mistral, Cerebras). Aucune de ces briques n'est facturée
 * dans sa formule gratuite ; Ollama ne demande même pas de compte.
 */

const RESPONSE_SCHEMA = z.toJSONSchema(CampaignPlanSchema) as Record<string, unknown>;

export interface OpenAiWriterOptions {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Certaines passerelles gratuites exigent un en-tête d'identification supplémentaire. */
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

type Mode = "json_schema" | "json_object" | "prompt";

export class OpenAiCompatibleWriter implements Writer {
  readonly id: string;
  readonly name: string;
  readonly free = true;

  constructor(private readonly options: OpenAiWriterOptions) {
    this.id = options.id;
    this.name = options.name;
  }

  async write(options: PlanOptions): Promise<CampaignPlan> {
    const messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${schemaInstruction()}` },
      { role: "user", content: buildUserMessage(options) },
    ];

    // Du plus contraint au plus permissif : tous les serveurs ne gèrent pas `json_schema`.
    const modes: Mode[] = ["json_schema", "json_object", "prompt"];
    let lastError: Error | null = null;

    for (const mode of modes) {
      try {
        options.onProgress?.(`rédaction (${this.name})`);
        const raw = await this.chat(messages, mode);
        return parsePlan(raw);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof UnsupportedModeError) continue;

        // Une seule reprise : on renvoie au modèle l'erreur de validation pour qu'il se corrige.
        try {
          options.onProgress?.("correction du plan");
          const raw = await this.chat(
            [
              ...messages,
              {
                role: "user",
                content:
                  `Ta réponse précédente n'était pas exploitable : ${lastError.message}\n` +
                  "Renvoie uniquement l'objet JSON valide, sans texte autour, sans bloc de code.",
              },
            ],
            mode === "json_schema" ? "json_object" : mode,
          );
          return parsePlan(raw);
        } catch (retryError) {
          lastError = retryError instanceof Error ? retryError : new Error(String(retryError));
        }
      }
    }

    throw new Error(`${this.name} n'a pas produit de plan exploitable : ${lastError?.message ?? "cause inconnue"}`);
  }

  private async chat(messages: Array<{ role: string; content: string }>, mode: Mode): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      temperature: 0.7,
      max_tokens: 8000,
      stream: false,
    };
    if (mode === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "campagne", strict: true, schema: RESPONSE_SCHEMA },
      };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 300_000);

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...this.options.extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${this.name} n'a pas répondu dans le délai imparti.`);
      }
      throw new Error(
        `Impossible de joindre ${this.options.baseUrl} : ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // Un 400 sur le format demandé signifie que le serveur ne gère pas ce mode.
      if (response.status === 400 && mode !== "prompt") {
        throw new UnsupportedModeError(detail.slice(0, 200));
      }
      throw new Error(`${this.name} a répondu ${response.status} : ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (payload.error?.message) throw new Error(payload.error.message);

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("réponse vide");
    return content;
  }
}

class UnsupportedModeError extends Error {}

function schemaInstruction(): string {
  return [
    "Réponds uniquement par un objet JSON valide, sans phrase d'introduction et sans bloc de code.",
    "Il doit respecter exactement ce schéma JSON :",
    JSON.stringify(RESPONSE_SCHEMA),
  ].join("\n");
}

/** Les modèles ouverts encadrent souvent leur JSON de texte : on va le rechercher. */
function parsePlan(raw: string): CampaignPlan {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1]);

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  candidates.push(raw);

  let lastError = "JSON introuvable dans la réponse";
  for (const candidate of candidates) {
    try {
      return CampaignPlanSchema.parse(JSON.parse(candidate));
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
    }
  }
  throw new Error(lastError);
}
