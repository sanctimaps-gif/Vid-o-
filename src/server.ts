import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { jobs } from "./jobs.js";
import { selectWriter, writerStatus } from "./ai/writer.js";
import { log } from "./util/log.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

export function createServer(outDir: string): express.Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(publicDir));
  // Les vidéos produites sont servies telles quelles pour la prévisualisation et le téléchargement.
  app.use("/files", express.static(path.resolve(outDir)));

  app.get("/api/config", (_request, response) => {
    void (async () => {
      const [writers, active] = await Promise.all([writerStatus(), selectWriter()]);
      response.json({
        writers,
        activeWriter: { id: active.id, name: active.name, free: active.free },
        tts: config.tts,
        outDir: path.resolve(outDir),
      });
    })();
  });

  app.post("/api/generate", (request, response) => {
    const body = request.body as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const brief = typeof body.brief === "string" ? body.brief.trim() : "";

    if (!url || !brief) {
      response.status(400).json({ error: "Il faut une adresse de site et une consigne." });
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocole");
    } catch {
      response.status(400).json({ error: "Adresse de site invalide (exemple : https://mon-site.com)." });
      return;
    }

    const rawCount = Number(body.count);
    const job = jobs.create({
      url,
      brief,
      count: Number.isFinite(rawCount) && rawCount > 0 ? Math.min(8, Math.round(rawCount)) : undefined,
      outDir,
      tts: body.tts === "none" || body.tts === "elevenlabs" || body.tts === "edge" ? body.tts : undefined,
      voice: typeof body.voice === "string" && body.voice ? body.voice : undefined,
      writer: typeof body.writer === "string" && body.writer ? body.writer : undefined,
    });

    response.status(202).json({ id: job.id });
  });

  app.get("/api/jobs/:id", (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) {
      response.status(404).json({ error: "Génération inconnue." });
      return;
    }
    response.json(serialize(job, outDir));
  });

  app.get("/api/jobs/:id/events", (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) {
      response.status(404).end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const send = (data: unknown): void => {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Rejouer l'historique permet de rouvrir l'onglet sans rien perdre.
    for (const event of job.events) send(event);
    if (job.status === "done" || job.status === "error") {
      send({ step: "final", detail: "", job: serialize(job, outDir) });
      response.end();
      return;
    }

    const onEvent = (event: unknown): void => {
      send(event);
      if (job.status === "done" || job.status === "error") {
        send({ step: "final", detail: "", job: serialize(job, outDir) });
        response.end();
      }
    };
    jobs.bus.on(job.id, onEvent);

    const keepAlive = setInterval(() => response.write(": ping\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(keepAlive);
      jobs.bus.off(job.id, onEvent);
    });
  });

  return app;
}

function serialize(job: ReturnType<typeof jobs.get> & object, outDir: string): unknown {
  const root = path.resolve(outDir);
  const toUrl = (absolute: string): string =>
    `/files/${path.relative(root, absolute).split(path.sep).map(encodeURIComponent).join("/")}`;

  return {
    id: job.id,
    status: job.status,
    brand: job.brand,
    error: job.error,
    outDir: job.outDir,
    events: job.events,
    videos: job.videos.map((video) => ({
      position: video.position,
      concept: video.concept,
      title: video.youtubeTitle,
      description: video.youtubeDescription,
      tags: video.tags,
      hashtags: video.hashtags,
      durationSeconds: video.durationSeconds,
      videoUrl: toUrl(video.videoPath),
      thumbnailUrl: toUrl(video.thumbnailPath),
    })),
  };
}

export function startServer(outDir: string, port = config.port): void {
  const app = createServer(outDir);
  app.listen(port, () => {
    log.success(`Vid-O est lancé sur http://localhost:${port}`);
    log.info(`Les vidéos sont écrites dans ${path.resolve(outDir)}`);
  });
}
