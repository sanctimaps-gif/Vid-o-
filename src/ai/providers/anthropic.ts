import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../../config.js";
import { CampaignPlanSchema, type CampaignPlan } from "../../types.js";
import { SYSTEM_PROMPT, buildUserMessage, type PlanOptions, type Writer } from "../prompt.js";

/**
 * Rédacteur Claude. C'est le seul fournisseur facturé à l'usage : il n'est jamais
 * sélectionné automatiquement, il faut le demander (VIDO_WRITER=anthropic ou --writer anthropic).
 */
export class AnthropicWriter implements Writer {
  readonly id = "anthropic";
  readonly name = `Claude (${config.model})`;
  readonly free = false;

  async write(options: PlanOptions): Promise<CampaignPlan> {
    if (!config.anthropicApiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(
        "ANTHROPIC_API_KEY n'est pas défini. Utilisez un rédacteur gratuit (--writer template ou --writer ollama), " +
          "ou renseignez votre clé dans .env.",
      );
    }

    const client = new Anthropic();
    options.onProgress?.("rédaction des scripts par Claude");

    const stream = client.messages.stream({
      model: config.model,
      max_tokens: 32_000,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: zodOutputFormat(CampaignPlanSchema),
      },
      messages: [{ role: "user", content: buildUserMessage(options) }],
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new Error(
        `Le modèle a refusé d'écrire cette campagne${
          message.stop_details?.explanation ? ` : ${message.stop_details.explanation}` : "."
        }`,
      );
    }

    const parsed = message.parsed_output;
    if (!parsed) {
      throw new Error("Le modèle n'a pas renvoyé de plan exploitable. Relancez la génération.");
    }
    return parsed;
  }
}
