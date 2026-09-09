import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { GenerateOptions, RenderedVideo } from "./types.js";
import { generateCampaign } from "./pipeline.js";

export type JobStatus = "pending" | "running" | "done" | "error";

export interface JobEvent {
  step: string;
  detail: string;
  at: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  brief: string;
  url: string;
  events: JobEvent[];
  videos: Array<RenderedVideo & { position: number }>;
  outDir?: string;
  brand?: string;
  error?: string;
}

class JobStore {
  private readonly jobs = new Map<string, Job>();
  readonly bus = new EventEmitter();

  constructor() {
    // Une page ouverte longtemps peut suivre plusieurs générations.
    this.bus.setMaxListeners(200);
  }

  create(options: Omit<GenerateOptions, "onProgress">): Job {
    const job: Job = {
      id: randomUUID(),
      status: "pending",
      createdAt: Date.now(),
      brief: options.brief,
      url: options.url,
      events: [],
      videos: [],
    };
    this.jobs.set(job.id, job);
    void this.run(job, options);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  private emit(job: Job, step: string, detail: string): void {
    const event: JobEvent = { step, detail, at: Date.now() };
    job.events.push(event);
    if (job.events.length > 400) job.events.splice(0, job.events.length - 400);
    this.bus.emit(job.id, event);
  }

  private async run(job: Job, options: Omit<GenerateOptions, "onProgress">): Promise<void> {
    job.status = "running";
    this.emit(job, "start", "démarrage");
    try {
      const result = await generateCampaign({
        ...options,
        onProgress: (step, detail = "") => {
          if (step === "done-video") {
            try {
              job.videos.push(JSON.parse(detail));
            } catch {
              /* payload illisible : l'événement reste informatif */
            }
          }
          this.emit(job, step, detail);
        },
      });
      job.outDir = result.outDir;
      job.brand = result.plan.brandName;
      job.status = "done";
      this.emit(job, "done", `${result.videos.length} vidéo(s) prête(s)`);
    } catch (error) {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      this.emit(job, "error", job.error);
    }
  }
}

export const jobs = new JobStore();
