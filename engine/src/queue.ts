import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./persist.js";

export type JobStatus = "held" | "queued" | "running" | "done" | "failed" | "cancelled";

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  duration?: 4 | 6 | 8 | 10;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  chain_from?: string;
  reference_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  // The scene number each agent scene is saved as. A retry of scenes 7 and 12 keeps scene-07 and scene-12; without it
  // the numbers run on from file_stem.
  agent_numbers?: number[];
  // Reference images for an agent batch: attached once as ingredients in the agent composer (absolute paths, uploaded
  // once, or "asset:<title>"), with a short name each, plus which of them every scene uses (names, per scene).
  agent_refs?: { image: string; name: string }[];
  agent_scene_refs?: string[][];
  // Flow asset names of agent_refs after upload, so a retry round re-attaches without uploading again.
  agent_ref_assets?: string[];
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
  // Links a job to a Studio plan scene so its finished file is recorded in plan.json.
  studio?: { project: string; sub: string; scene: number; kind: "storyboard" | "clip" };
}

export interface Job {
  id: string;
  status: JobStatus;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  progress?: string;
  note?: string;
  error?: string;
  // Scene numbers a batch still could not make after all its own retries; flow_retry redoes just these.
  failed_scenes?: number[];
  // Jobs added together share a batch, so one OK from the owner releases them all.
  batch?: string;
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job) => Promise<string[]>;

// Flow is driven like a careful person would: one generation at a time, with a
// randomised pause between them.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;

const STOPPED = "Studio stopped while this was generating — it may have spent credits. Check Flow before retrying.";
const needsOk = (p: SceneParams) => p.type === "video" || Boolean(p.edit_asset || p.continue_from);

export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  private manualPause: string | null = null;
  private pacing: string | null = null;
  private pauseMs: [number, number];
  // Only the process that owns the Flow tab restores and writes the shared file (see restore()).
  private active = false;

  constructor(private runner: JobRunner, private opts: { file?: string; pauseMs?: [number, number]; onDone?: (job: Job) => void } = {}) {
    this.pauseMs = opts.pauseMs ?? [PAUSE_MIN_MS, PAUSE_MAX_MS];
  }

  // Loads the file, fails jobs that were running when the last owner died, re-holds approved paid jobs, and resumes queued work. Call it only in
  // the process that drives Flow: a client process that loaded the file would fail the owner's live job and run paid jobs.
  restore(): void {
    if (!this.opts.file) return;
    for (const j of readJson<Job[]>(this.opts.file, [])) {
      if (j.status === "running") {
        j.status = "failed";
        j.error = STOPPED;
        j.finishedAt = new Date().toISOString();
      }
      // An approval does not outlive the process: after a restart the owner looks at paid work again.
      if (j.status === "queued" && needsOk(j.params)) j.status = "held";
      this.jobs.set(j.id, j);
    }
    this.active = true;
    this.save();
    // Deferred: the runner may use fields its owner assigns after construction.
    if (this.list().some((j) => j.status === "queued")) queueMicrotask(() => void this.work());
  }

  get pausedReason(): string | null {
    return this.manualPause ?? this.pacing;
  }

  private save(): void {
    if (!this.opts.file || !this.active) return;
    try { writeJsonAtomic(this.opts.file, this.list()); } catch (e) { console.error(`flow-mcp: could not save ${this.opts.file}: ${(e as Error).message}`); }
  }

  pause(reason: string): void {
    this.manualPause = reason;
  }

  resume(): void {
    this.manualPause = null;
    void this.work();
  }

  add(params: SceneParams, opts: { batch?: string } = {}): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: needsOk(params) ? "held" : "queued",
      params,
      files: [],
      attempts: 0,
      batch: opts.batch,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.save();
    void this.work();
    return job;
  }

  // Only the studio UI may call this (see server.ts): it is what releases jobs that spend credits.
  approve(target: { batch?: string; job_id?: string }): Job[] {
    if (!target.batch && !target.job_id) return [];
    const hit = this.list().filter((j) => j.status === "held" && (j.id === target.job_id || (target.batch && j.batch === target.batch)));
    for (const j of hit) j.status = "queued";
    this.save();
    void this.work();
    return hit;
  }

  pendingApproval(): { batch?: string; jobs: Job[]; max_credits: number; cost_unknown: boolean }[] {
    const groups = new Map<string, { batch?: string; jobs: Job[]; max_credits: number; cost_unknown: boolean }>();
    for (const j of this.list().filter((x) => x.status === "held")) {
      const g = groups.get(j.batch ?? j.id) ?? { batch: j.batch, jobs: [], max_credits: 0, cost_unknown: false };
      g.jobs.push(j);
      g.max_credits += j.params.max_credits;
      // Edits and continues have no quote before they run, so their max_credits of 0 is not a price.
      if (j.params.edit_asset || j.params.continue_from) g.cost_unknown = true;
      groups.set(j.batch ?? j.id, g);
    }
    return [...groups.values()];
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  // Puts a failed or cancelled job back in line with the same settings and file name.
  retry(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = needsOk(job.params) ? "held" : "queued";
      job.error = undefined;
      job.finishedAt = undefined;
      this.save();
      void this.work();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "queued" || job.status === "held")) {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.save();
    }
    return job;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        if (this.manualPause) return;
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished) {
          const pause = this.pauseMs[0] + Math.random() * (this.pauseMs[1] - this.pauseMs[0]);
          const remaining = this.lastFinished + pause - Date.now();
          if (remaining > 0) {
            this.pacing = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pacing = null;
          }
        }
        if (job.status !== "queued" || this.manualPause) continue;
        job.status = "running";
        job.attempts++;
        this.save();
        try {
          job.files = await this.runner(job);
          job.status = "done";
          job.error = undefined;
          try { this.opts.onDone?.(job); } catch (e) { console.error(`flow-mcp: onDone failed: ${(e as Error).message}`); }
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          // Failed tiles are already retried inside Flow (its own Retry button); only an agent that produced nothing
          // is re-queued here. Timeouts are never retried automatically: they may still have spent credits.
          const retryable = /agent finished without creating/i.test(job.error);
          job.status = retryable && job.attempts <= (job.params.retries ?? 1) ? "queued" : "failed";
        }
        job.finishedAt = new Date().toISOString();
        this.save();
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }
}
