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
  // Job whose clip's last frame becomes this job's first frame; the job waits for it and is cancelled if it fails.
  chain_from?: string;
  // A finished clip on disk whose last frame becomes the first frame (the source is not in this batch).
  chain_file?: string;
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
  // `from`: the scene whose last frame this clip starts on (display only; chain_from/chain_file do the work).
  studio?: { project: string; sub: string; scene: number; kind: "storyboard" | "clip"; from?: number };
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
  // Where the finished media sits in Flow: the Google account (hashed email, see switcher.accountId) and the Flow
  // project path. Edits and continues of it must run there.
  flow?: FlowLocation;
  createdAt: string;
  finishedAt?: string;
}

export type FlowLocation = { account: string; flowProject: string };

export type JobRunner = (job: Job) => Promise<string[]>;

// Thrown by a runner that gave up before generating anything and wants the job run again later (e.g. every account is
// out of credits and the queue was paused): the job goes back to "queued" instead of "failed".
export class Requeue extends Error {}

// Flow is driven like a careful person would: one generation at a time, with a
// randomised pause between them.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;
// Free image jobs (storyboard stills) are quick and cheap for Flow, so they wait less (owner's choice, 2026-10-31).
const IMAGE_PAUSE_MIN_MS = Number(process.env.FLOW_MCP_IMAGE_PAUSE_MIN_S ?? 5) * 1000;
const IMAGE_PAUSE_MAX_MS = Number(process.env.FLOW_MCP_IMAGE_PAUSE_MAX_S ?? 15) * 1000;

const STOPPED = "Studio stopped while this was generating — it may have spent credits. Check Flow before retrying.";
const needsOk = (p: SceneParams) => p.type === "video" || Boolean(p.edit_asset || p.continue_from);

export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  private manualPause: string | null = null;
  private pacing: string | null = null;
  private pauseMs: [number, number];
  private imagePauseMs: [number, number];
  // Only the process that owns the Flow tab restores and writes the shared file (see restore()).
  private active = false;
  // Note text a Requeue added, removed again when the job next runs (it no longer describes the job).
  private requeueNote = new Map<string, string>();

  constructor(private runner: JobRunner, private opts: { file?: string; pauseMs?: [number, number]; imagePauseMs?: [number, number]; onDone?: (job: Job) => void } = {}) {
    this.pauseMs = opts.pauseMs ?? [PAUSE_MIN_MS, PAUSE_MAX_MS];
    this.imagePauseMs = opts.imagePauseMs ?? (opts.pauseMs ? this.pauseMs : [IMAGE_PAUSE_MIN_MS, IMAGE_PAUSE_MAX_MS]);
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
    for (const j of this.list()) if (j.status === "failed" || j.status === "cancelled") this.dropDependents(j);
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

  cancel(id: string, note?: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "queued" || job.status === "held")) {
      job.status = "cancelled";
      if (note) job.note = [job.note, note].filter(Boolean).join(" · ");
      job.finishedAt = new Date().toISOString();
      this.dropDependents(job);
      this.save();
    }
    return job;
  }

  // A job chained to a prior clip cannot run without it: when the prior fails or is cancelled, its waiting
  // dependents (and theirs) are cancelled before anything is spent.
  private dropDependents(prior: Job): void {
    for (const j of this.list()) {
      if (j.params.chain_from !== prior.id || (j.status !== "held" && j.status !== "queued")) continue;
      j.status = "cancelled";
      j.finishedAt = new Date().toISOString();
      const what = prior.params.studio ? `scene ${prior.params.studio.scene}'s clip` : `the clip it continues from (job ${prior.id})`;
      j.note = [j.note, `Not run: ${what} ${prior.status === "failed" ? "failed" : "was cancelled"}, so there is no last frame to start from. Nothing spent.`].filter(Boolean).join(" · ");
      this.dropDependents(j);
    }
  }

  // Waiting for the clip it continues from (stays in line, approved with its batch, until that clip is done).
  private waiting(j: Job): boolean {
    const p = j.params.chain_from ? this.jobs.get(j.params.chain_from) : undefined;
    return !!p && (p.status === "held" || p.status === "queued" || p.status === "running");
  }

  private gate: Promise<unknown> = Promise.resolve();
  // Runs fn only when no job is running, and keeps work() from starting one until fn settles (no await between the check and the gate).
  async whileIdle<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) return undefined;
    const p = fn();
    this.gate = p.catch(() => {});
    return p;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        if (this.manualPause) return;
        const job = this.list().find((j) => j.status === "queued" && !this.waiting(j));
        if (!job) return;
        if (this.lastFinished) {
          const [lo, hi] = job.params.type === "image" ? this.imagePauseMs : this.pauseMs;
          const pause = lo + Math.random() * (hi - lo);
          const remaining = this.lastFinished + pause - Date.now();
          if (remaining > 0) {
            this.pacing = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pacing = null;
          }
        }
        // Re-check: another whileIdle may have replaced the gate while we waited. Capped so a hung read can't stall the queue forever.
        for (let g = this.gate; ; g = this.gate) {
          await Promise.race([g, new Promise((r) => setTimeout(r, 60_000).unref())]);
          if (g === this.gate) break;
        }
        if (job.status !== "queued" || this.manualPause) continue;
        job.status = "running";
        job.attempts++;
        const stale = this.requeueNote.get(job.id);
        if (stale) {
          job.note = job.note?.split(" · ").filter((p) => p !== stale).join(" · ") || undefined;
          this.requeueNote.delete(job.id);
        }
        this.save();
        try {
          job.files = await this.runner(job);
          job.status = "done";
          job.error = undefined;
          try { this.opts.onDone?.(job); } catch (e) { console.error(`flow-mcp: onDone failed: ${(e as Error).message}`); }
        } catch (err) {
          if (err instanceof Requeue) {
            job.status = "queued";
            job.attempts--;
            job.note = [job.note, err.message].filter(Boolean).join(" · ");
            this.requeueNote.set(job.id, err.message);
            if (!this.manualPause) this.manualPause = err.message; // never spin on a job that cannot run
            this.save();
            continue; // the loop's pause check stops here until resume()
          }
          job.error = err instanceof Error ? err.message : String(err);
          // Failed tiles are already retried inside Flow (its own Retry button); only an agent that produced nothing
          // is re-queued here. Timeouts are never retried automatically: they may still have spent credits.
          const retryable = /agent finished without creating/i.test(job.error);
          job.status = retryable && job.attempts <= (job.params.retries ?? 1) ? "queued" : "failed";
          if (job.status === "failed") this.dropDependents(job);
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
