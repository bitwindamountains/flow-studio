import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assemble, localVoices, speakLocally, voiceTrack } from "./assemble.js";
import { GEMINI_VOICES, geminiKey, saveGeminiKey, speakWithGemini } from "./gemini.js";
import { extractLastFrame } from "./chain.js";
import { burnCaptions, captionedName, captionSetup, previewCaptions, transcribe } from "./captions.js";
import { characterLook, createCharacter, downloadAsset, trashAsset, editCharacter, getFlowState, listAssets, listCharacters, rememberCharacter, runAgentBatch, runContinue, runEdit, runGeneration } from "./flow.js";
import { JobQueue, type Job, type JobRunner, type SceneParams } from "./queue.js";
import { HOME_DIR, getFlowPage } from "./chrome.js";
import { ACCOUNTS_FILE, currentLocation, discoverAccounts, ensureAffordable, ensureJobProject, findSource, goToSource } from "./switcher.js";
import { BIN, COMPUTER, IS_MAC, IS_WIN, moveToBin } from "./platform.js";
import { PlanSchema, isStill, sceneSettings, projDir, subDir, safeName, addReference, createSub, listProjects, notesRev, planRev, readNotes, readPlan, uploadsDir, within, writeNotes, writePlan } from "./projects.js";
import { readJson, writeJsonAtomic } from "./persist.js";
import { STEP_ORDER, approveStep, blockStep, pauseWorking, readSteps, remaining, reopenStep, requestChanges, reserve, resumeStep, setBudget, settle, startStep, submitStep, type StepName, type StepState } from "./steps.js";
import { clipsDir, handoff, listRenders, renderDone } from "./handoff.js";
import { proposeLesson, readLessons } from "./lessons.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";
import { activeEdit, readEdit, startEdit, updateEdit, finishEdit } from "./edit-tasks.js";
import { deriveWorkflow } from "./workflow.js";
import { UiContextSchema, UiContextStore, UiPublicationSchema, type UiContext } from "./ui-context.js";
import { creativeGuideInfo, readCreativeGuide } from "./creative-guide.js";

export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
const words = (s: string) => s.split(/[^a-z0-9]+/i).filter((w) => w.length > 3).map((w) => w.toLowerCase());

export const projectDir = (project: string) => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));

const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z
    .string()
    .optional()
    .describe("Model label as shown in Flow, e.g. 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana Pro'. Images default to the newest Nano Banana (2.1 today); video omitted keeps Flow's current model."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Video length in seconds. Omni models only; Veo 3.1 clips are fixed at 8s."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z.number().int().min(0).default(25).describe("Safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: z.string().optional().describe("First frame: absolute image path, or 'asset:<title>' for an image already in the Flow project."),
  last_frame: z.string().optional().describe("Last frame: absolute image path, or 'asset:<title>'."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe(
      "Reference media: absolute image paths, or 'asset:<title>' for media or characters already in the Flow project. Flow's COMPOSER takes references OR first/last frames on a video scene, never both, so with frames set these are skipped and the job says so. Flow itself can do both via agent mode (save the last frame, Animate it, then add the character).",
    ),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image (free, slower). Default original."),
  retries: z.number().int().min(0).max(3).default(1).describe("Automatic retries when Flow itself reports the generation failed."),
  technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  reference_previous: z
    .boolean()
    .optional()
    .describe("Use the previous scene's finished image as an extra reference, so this scene inherits its exact drawing of the characters, style and palette. Best way to keep a set of stills on-model."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
});

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
const captionFields = {
  video: z.string().min(1).describe("Absolute path of the video to caption: any MP4 or MOV on this computer, such as a film made with flow_assemble."),
  style: z
    .enum(["bold", "highlight", "reveal", "clean", "boxed"])
    .default("bold")
    .describe(
      "bold: big capitals, 1-3 words at a time, the spoken word lights up (the short-form look). highlight: the spoken word sits on a coloured block. reveal: words appear as they are said. clean: classic subtitles. boxed: white words on a dark band.",
    ),
  position: z
    .union([z.enum(["bottom", "middle", "top"]), z.number().min(0).max(100)])
    .default("bottom")
    .describe("bottom, middle or top - or a number for an exact height: how far down the frame the middle of the caption sits, 0 = top edge, 100 = bottom edge."),
  size: z
    .union([z.enum(["small", "medium", "large"]), z.number().min(40).max(250)])
    .default("medium")
    .describe("small, medium, large, or a percentage of the style's normal size (100 = medium, 150 = half again as big)."),
  lead: z
    .number()
    .min(-0.5)
    .max(0.5)
    .optional()
    .describe("Seconds the highlight runs ahead of the voice. Default 0.12; raise it if words still light up late, lower it if early."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Highlight colour as #RRGGBB, for bold, highlight and reveal."),
  letters: z
    .enum(["as_said", "capitals", "lowercase"])
    .optional()
    .describe("as_said keeps normal capitals (sentence starts, names); capitals is the high-energy short-form look; lowercase is the calm, casual look, and names still keep their capital in it. Default: capitals for bold, as_said for the rest."),
  names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Lowercase only: names to keep capitalised even where they start a sentence (e.g. [\"Juno\"]). Names in the middle of a sentence are found by themselves."),
  text: z.string().max(50_000).optional().describe("Corrected words, to fix anything misheard. Timings are kept for every word that still matches; a line break starts a new caption."),
  language: z
    .string()
    .default("auto")
    .describe(
      "Spoken language as a code: en, es, fr, de, pt, tr, ja, zh, ar... Pass it whenever you know it. auto detects it (a 60 MB detector downloads once). English uses a 148 MB model; every other language a 574 MB one, each downloaded the first time.",
    ),
};

const PS = {
  project: z.string().min(1).optional().describe("Optional: defaults to the project the owner selected in the studio (see studio_current)."),
  sub: z.string().min(1).optional().describe("Optional: defaults to the sub-project the owner selected in the studio."),
};
const StepEnum = z.enum(STEP_ORDER);
export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips the plan/credits readout, which briefly opens Flow's account panel.") },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
    scenes: z.array(sceneSchema).min(1).max(100),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids from a queued call, or the task_id of a call that answered still_working. Default: every queued job."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("An MCP call returns after at most 40 s whatever this says, so call again until finished is true."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs to re-queue. Default: every failed job.") },
  assets: { kind: z.enum(["image", "video", "scene"]).optional() },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z.array(z.string().min(1)).min(1).max(30).describe("Titles (or title prefixes) from flow_assets, in the order they should be numbered."),
    quality: z.enum(["original", "upscaled"]).default("original"),
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    voice_lines: z
      .array(
        z.object({
          file: z.string().min(1).describe("Take to cut the line from: audio or video (its sound is used)."),
          from: z.number().min(0).optional().describe("Start of the line within the take, seconds (from flow_transcribe word times)."),
          to: z.number().min(0).optional().describe("End of the line within the take, seconds."),
          at: z.number().min(0).describe("Where the line starts in the film, seconds."),
          max_seconds: z.number().min(0.2).optional().describe("Longest it may last; a longer line is sped up slightly (at most 1.25x)."),
        }),
      )
      .max(60)
      .optional()
      .describe(
        "A timed voiceover built from separate lines, each placed at its own moment in the film - for example lines cut from several Flow takes in your avatar's voice, each landing on the title it describes. Replaces `voiceover`.",
      ),
    output_name: z.string().default("final"),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
  },
  transcribe: {
    video: z.string().min(1).describe("Absolute path of a video or audio file on this computer."),
    language: z.string().default("auto").describe("Spoken language code (en, es, tr, ja...) or auto. Pass it whenever you know it."),
    words: z.boolean().default(true).describe("Include every word with its start and end time in seconds."),
  },
  caption_preview: captionFields,
  captions: {
    ...captionFields,
    project: z.string().optional().describe("Films folder to save into. Default: the video's own folder when it is already in the films folder, otherwise 'Captions'."),
  },
  caption_setup: {},
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    references: z
      .array(
        z.object({
          image: z.string().min(1).describe("Absolute image path, or 'asset:<title>' for an image or character already in the Flow project."),
          name: z.string().min(1).max(40).describe("Short name the scenes use for it, e.g. 'Ines' or 'the station'."),
        }),
      )
      .max(10)
      .optional()
      .describe(
        "Reference images for the whole batch (characters, places, objects), attached once in the agent's composer like the + button does, so every scene stays on-model. Pair with scene_references to say which scenes use which.",
      ),
    scene_references: z
      .array(z.array(z.string()))
      .optional()
      .describe("One list per scene, in scene order: the reference names that scene uses (empty list for none). Without it the agent decides which references fit each scene."),
  },
  voices: {},
  narrate: {
    project: z.string().min(1).describe("Folder for the narration audio."),
    engine: z
      .enum(["gemini", "mac"])
      .default("gemini")
      .describe(
        "'gemini' uses Google AI Studio's text-to-speech - the same voices Flow has, free on the AI Studio tier, no length limit, needs a key in ~/.flow-mcp/gemini-key. 'mac' uses a voice installed on this computer (macOS voices on a Mac, the built-in speech voices on Windows): free, instant, no key.",
      ),
    text: z.string().min(1).max(400).describe("The line to speak. About 20 words fits 8 s, 30 words fits 12 s; anything longer needs a longer take."),
    voice: z.string().min(1).default("Charon").describe("Voice name from flow_voices, e.g. Charon (informative), Aoede (breezy), Gacrux (mature) for Google; Zoe or Samantha for macOS."),
    style: z.string().max(200).optional().describe("Delivery note for the 'gemini' engine, e.g. 'slowly and warmly, like a documentary narrator'."),
  },
  edit: {
    project: z.string().min(1).describe("Local folder for the edited clip."),
    asset: z.string().min(1).describe("Title (or title prefix) of a video already in the Flow project; see flow_assets."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Flow shows no quote for edits, so max_credits cannot protect you: a 4 s clip cost 20 credits when measured. The real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
  },
  continue_shot: {
    project: z.string().min(1).describe("Local folder for the new clip."),
    from_asset: z.string().min(1).describe("Title (or title prefix) of the video to continue from; see flow_assets."),
    prompt: z.string().min(1).describe("What happens in the new clip, written as one continuous shot with one camera move."),
    attach: z
      .array(z.string().min(1))
      .max(3)
      .optional()
      .describe("Characters or avatars to keep attached, by name, e.g. ['Me'] for your own Flow avatar or ['Pip']. This is the whole point of this tool: the normal composer cannot hold a character and a start frame at the same time."),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    mode: z
      .enum(["exact", "likeness"])
      .default("exact")
      .describe(
        "'exact' uses Flow's first-frame animation (I2V): the clip begins on the source clip's real last frame, invisible cut, but attached characters are IGNORED - the likeness has to come from the frame itself. 'likeness' uses reference-to-video (R2V): the character stays locked but the opening frame is only approximate. Flow cannot do both; this is a model limit, not a UI one.",
      ),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Agent mode shows no credit quote before it runs, so max_credits cannot protect you; the real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    force: z
      .boolean()
      .optional()
      .describe("Skip the guard that refuses to run when Flow already holds a fresh-looking continuation of this clip. Only pass it when you have checked the grid and genuinely want another paid take."),
  },
  trash: { name: z.string().min(1).describe("Exact title of the item to move to Flow's Trash, as listed by flow_assets.") },
  set_key: { key: z.string().min(1).max(200) },
  discard: { path: z.string().min(1).describe("A saved film, still, narration or whole project folder inside the films folder, to move to this computer's bin (Mac Trash, Windows Recycle Bin).") },
  outputs: {},
  characters: {},
  character_edit: {
    name: z.string().min(1).describe("Character to change, as listed by flow_characters."),
    change: z
      .string()
      .min(1)
      .max(600)
      .optional()
      .describe(
        "What to change about the look, e.g. 'make his coat red, keep everything else the same'. Leave it out to only save the character's current portrait (after a change made by hand in Flow, or one whose portrait never arrived).",
      ),
    look: z
      .string()
      .min(1)
      .max(1500)
      .optional()
      .describe(
        "The character's whole description AFTER the change, e.g. the old one with 'navy coat' swapped for 'red coat'. Scenes quote it word for word to hold the design, so a stale colour in it fights the new portrait. Without it, the change is added to the end of the old description.",
      ),
  },
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then reference it as 'asset:<name>' in reference_images."),
    describe: z
      .string()
      .max(1200)
      .optional()
      .describe("What the character looks like. Flow draws the portrait first (free image), then builds the character from it. Use this or `image`."),
    image: z
      .string()
      .min(1)
      .optional()
      .describe("Existing picture instead of `describe`: absolute path, or 'asset:<title>' of an image already in the Flow project."),
    aspect_ratio: z.enum(["3:4", "1:1", "9:16", "16:9", "4:3"]).optional().describe("Frame for the drawn portrait when using `describe`. Default 3:4."),
    personality: z.string().max(500).optional().describe("How the character acts; Flow uses it when crafting scenes."),
    voice: z.string().optional().describe("Flow voice name, e.g. 'Charon' (male, informative) or 'Aoede' (female, breezy)."),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
  studio_projects: {},
  studio_select: { project: z.string().min(1), sub: z.string().min(1) },
  studio_current: {},
  studio_workflow_read: { ...PS },
  studio_context_read: {},
  studio_guide_read: { stage: z.enum(["ideas", "plan", "storyboard"]) },
  studio_references: { ...PS },
  studio_new: { project: z.string().min(1), sub: z.string().min(1), aspect: z.enum(["9:16", "16:9"]).default("9:16") },
  studio_plan_read: { ...PS },
  studio_plan_write: { ...PS, rev: z.number().int().min(0).describe("The plan `rev` from your last studio_plan_read."), plan: PlanSchema },
  studio_notes_read: { ...PS },
  studio_storyboard: { ...PS, scenes: z.array(z.number().int()).optional() },
  studio_generate: {
    ...PS, scenes: z.array(z.number().int()).optional(),
    duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Override for every scene. Normally leave unset: each scene's own duration/resolution/model (set in the plan) apply, then the default Omni 1.1 Flash / 8 s / 720p."),
    resolution: z.enum(["360p", "720p"]).optional(),
    model: z.string().optional(),
    max_credits: z.number().min(0).optional().describe("Cap per clip. Default depends on the model (Omni 20, Veo Lite 15, Fast 25, Quality 110)."),
  },
  studio_redo: {
    ...PS, scene: z.number().int(), prompt: z.string().optional(),
    duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Defaults to the scene's own duration."),
    resolution: z.enum(["360p", "720p"]).optional().describe("Defaults to the scene's own resolution."),
    model: z.string().optional().describe("Defaults to the scene's own model."),
  },
  studio_status: { ...PS },
  studio_to_remotion: { ...PS, music: z.string().optional(), voiceover: z.string().optional() },
  studio_propose_lesson: { text: z.string().min(1), scope: z.string().default("global") },
  studio_accounts_refresh: {},
  studio_edit_notes_read: { ...PS },
  studio_edit_task_read: { ...PS },
  studio_edit_task_update: { ...PS, task_id: z.string().min(1), phase: z.enum(["accepted", "editing", "rendering", "failed"]), message: z.string().max(2000).optional() },
  studio_edit_notes_write: { ...PS, text: z.string(), rev: z.string().optional().describe("The `rev` from your last studio_edit_notes_read; the write is refused if the edit notes changed since.") },
  studio_render_done: { ...PS, task_id: z.string().optional(), file: z.string().min(1).describe("Absolute path of the finished render (mp4/webm/mov) inside the Remotion project's out/ folder.") },
  studio_renders: { ...PS },
  studio_step_read: { ...PS },
  studio_step_submit: { ...PS, step: StepEnum, summary: z.string().min(1).describe("At most 3 lines and 400 characters."), flags: z.array(z.object({ scene: z.number().int().optional(), at: z.number().optional(), note: z.string().max(200) })).default([]), picks: z.array(z.object({ scene: z.number().int(), clip: z.string() })).optional() },
  studio_step_blocked: { ...PS, step: StepEnum, reason: z.string().min(1).max(400) },
  studio_production_plan_read: { ...PS },
  studio_production_plan_write: { ...PS, text: z.string().max(400_000), rev: z.string().optional().describe("The `rev` from your last studio_production_plan_read; the write is refused if the plan changed since.") },
  studio_notes_write: { ...PS, text: z.string(), rev: z.string().optional().describe("The notes `rev` from your last studio_notes_read; the write is refused if the notes changed since.") },
  studio_add_reference: { project: PS.project, sub: z.string().optional().describe("Omit for a project-level reference."), path: z.string().describe("A file already uploaded through the studio page (inside the uploads folder).") },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export const jobView = ({ id, status, params, files, attempts, credits, progress, note, error, failed_scenes }: Job) => ({
  id,
  status,
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  attempts,
  credits,
  progress,
  files,
  note,
  error,
  failed_scenes,
});

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  voices(): Promise<unknown>;
  narrate(a: Args<"narrate">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  trash(a: Args<"trash">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  set_key(a: Args<"set_key">): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
  transcribe(a: Args<"transcribe">): Promise<unknown>;
  caption_preview(a: Args<"caption_preview">): Promise<unknown>;
  captions(a: Args<"captions">): Promise<unknown>;
  caption_setup(): Promise<unknown>;
  studio_projects(): Promise<unknown>;
  studio_select(a: Args<"studio_select">): Promise<unknown>;
  studio_current(): Promise<unknown>;
  studio_workflow_read(a: Args<"studio_workflow_read">): Promise<unknown>;
  studio_context_read(): Promise<unknown>;
  studio_guide_read(a: Args<"studio_guide_read">): Promise<unknown>;
  studio_references(a: Args<"studio_references">): Promise<unknown>;
  studio_add_reference(a: Args<"studio_add_reference">): Promise<unknown>;
  studio_new(a: Args<"studio_new">): Promise<unknown>;
  studio_plan_read(a: Args<"studio_plan_read">): Promise<unknown>;
  studio_plan_write(a: Args<"studio_plan_write">): Promise<unknown>;
  studio_notes_read(a: Args<"studio_notes_read">): Promise<unknown>;
  studio_notes_write(a: Args<"studio_notes_write">): Promise<unknown>;
  studio_step_read(a: Args<"studio_step_read">): Promise<unknown>;
  studio_step_submit(a: Args<"studio_step_submit">): Promise<unknown>;
  studio_step_blocked(a: Args<"studio_step_blocked">): Promise<unknown>;
  studio_production_plan_read(a: Args<"studio_production_plan_read">): Promise<unknown>;
  studio_production_plan_write(a: Args<"studio_production_plan_write">): Promise<unknown>;
  studio_edit_notes_read(a: Args<"studio_edit_notes_read">): Promise<unknown>;
  studio_edit_task_read(a: Args<"studio_edit_task_read">): Promise<unknown>;
  studio_edit_task_update(a: Args<"studio_edit_task_update">): Promise<unknown>;
  studio_edit_notes_write(a: Args<"studio_edit_notes_write">): Promise<unknown>;
  studio_render_done(a: Args<"studio_render_done">): Promise<unknown>;
  studio_renders(a: Args<"studio_renders">): Promise<unknown>;
  studio_storyboard(a: Args<"studio_storyboard">): Promise<unknown>;
  studio_generate(a: Args<"studio_generate">): Promise<unknown>;
  studio_redo(a: Args<"studio_redo">): Promise<unknown>;
  studio_status(a: Args<"studio_status">): Promise<unknown>;
  studio_to_remotion(a: Args<"studio_to_remotion">): Promise<unknown>;
  studio_propose_lesson(a: Args<"studio_propose_lesson">): Promise<unknown>;
  studio_accounts_refresh(): Promise<unknown>;
}

// Flow's own voices: still offered when giving a character a voice, but narration no longer goes through Flow.
export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

const SELECTION_FILE = join(HOME_DIR, "selection.json");
const NO_SELECTION = "No project selected in the studio - ask the owner to pick one.";
const READING_ACCOUNTS = "Reading Google accounts…";
const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

// Content identity, independent of plan rev: unrelated captions/notes and other scenes may change safely.
const sceneInput = (plan: ReturnType<typeof readPlan>, scene: ReturnType<typeof readPlan>["scenes"][number], kind: "storyboard" | "clip") => JSON.stringify([
  plan.aspect, scene.prompt, scene.frame_prompt, scene.camera, scene.start ?? { kind: "frame" }, scene.references ?? [],
  ...(kind === "clip" ? [scene.storyboard, scene.model, scene.duration, scene.resolution] : []),
  "ad-references", plan.references ?? [],
]);

// Launches and stops a step's agent run (Task 6). It never touches step state: LocalCore.gate owns every transition.
export interface StepStarter { start(project: string, sub: string, step: StepName): void; stop(project: string, sub: string): void }
export type GateAction = "approve" | "changes" | "reopen" | "budget" | "resume" | "start";

export class LocalCore implements Core {
  private uiContext = new UiContextStore();
  private editSession = randomUUID();
  private editScopes = new Map<string, { project: string; sub: string }>();
  readonly queue: JobQueue;
  private selection: { project: string; sub: string } | null;
  private lastFrame: (video: string) => Promise<string>;
  starter: StepStarter;
  constructor(init: { runner?: JobRunner; queueOpts?: { file?: string; pauseMs?: [number, number] }; lastFrame?: (video: string) => Promise<string>; starter?: StepStarter } = {}) {
    this.starter = init.starter ?? { start() {}, stop() {} };
    try { this.selection = readJson(SELECTION_FILE, null); } catch { this.selection = null; }
    this.lastFrame = init.lastFrame ?? extractLastFrame;
    const run = init.runner ?? this.defaultRunner;
    this.queue = new JobQueue(async (job) => {
      this.unspent.delete(job.id);
      try { await this.prepare(job); } catch (e) { this.unspent.add(job.id); throw e; }
      return run(job);
    }, { file: join(HOME_DIR, "queue.json"), onDone: (j) => this.recordDone(j), onFinish: (j) => this.settleJob(j), onRestore: () => this.pauseSteps(), ...init.queueOpts });
  }

  // Jobs that failed in prepare(), before the browser was touched: their reservation settles at 0.
  private unspent = new Set<string>();
  // A reserved job settles with its measured credits, else the reserved cap (a failed run may still have spent), or 0
  // when it never reached the browser.
  private settleJob(j: Job): void {
    const st = j.params.studio;
    const never = j.status === "cancelled" || this.unspent.delete(j.id);
    if (!st?.step) return;
    const measured = j.credits !== undefined && Number.isFinite(j.credits) && j.credits >= 0 ? j.credits : undefined;
    settle(st.project, st.sub, j.id, measured ?? (never ? 0 : undefined));
  }

  // After a restart no step spends again until the owner resumes it. Subs without a steps.json are left alone.
  private pauseSteps(): void {
    for (const { project, subs } of listProjects()) for (const sub of subs) {
      try {
        if (!existsSync(join(subDir(project, sub), "steps.json"))) continue;
        if (Object.values(readSteps(project, sub).steps).some((x) => x.status === "working" && !x.paused)) pauseWorking(project, sub);
      } catch (e) { console.error(`flow-mcp: could not pause steps of ${project}/${sub}: ${(e as Error).message}`); }
    }
  }

  // Owner route only (server.ts), never an MCP tool: releases the step's held jobs that still hold a reservation.
  resumeStepJobs(project: string, sub: string, name: StepName): string[] {
    const reserved = new Set(readSteps(project, sub).steps[name].reservations.map((r) => r.job));
    const ids = this.queue.list().filter((j) => j.status === "held" && reserved.has(j.id) && j.params.studio?.project === project && j.params.studio.sub === sub && j.params.studio.step === name).map((j) => j.id);
    for (const id of ids) this.queue.approve({ job_id: id });
    return ids;
  }

  // Owner route only (/api/step in server.ts), never an MCP tool: every owner gate action and its effects.
  gate(a: { project: string; sub: string; step: StepName; action: GateAction; text?: string; scene?: number; at?: number; credits?: number; budgets?: Partial<Record<"look" | "assets", number>> }): StepState {
    const { project, sub } = this.pick(a), { step } = a;
    const run = (n: StepName) => { startStep(project, sub, n); this.starter.start(project, sub, n); };
    switch (a.action) {
      case "approve": {
        if (readSteps(project, sub).steps[step].status !== "review") throw new Error(`${step[0].toUpperCase() + step.slice(1)} is not ready for review.`);
        const plan = readPlan(project, sub), file = (f?: string) => !!f && existsSync(f);
        if (step === "idea" && !plan.chosen) throw new Error("Choose an idea before approving Idea.");
        if (step === "edit" && !listRenders(project, sub).length) throw new Error("Render the video before approving Edit.");
        if (step === "plan") for (const [n, c] of Object.entries(a.budgets ?? {})) setBudget(project, sub, n as StepName, c);
        if (step === "look") {
          for (const s of plan.scenes) if (file(s.storyboard) || s.start?.kind === "continue") s.approved = true;
          writePlan(plan);
        }
        if (step === "assets") {
          // restoreTake clears Keep and marks dependents stale, so every pick goes in before anything is kept.
          for (const p of readSteps(project, sub).steps.assets.picks ?? [])
            if (plan.scenes.find((s) => s.n === p.scene)?.clip !== p.clip) this.restoreTake({ project, sub, scene: p.scene, clip: p.clip });
          const now = readPlan(project, sub);
          for (const s of now.scenes) if (isStill(s) ? file(s.storyboard) : file(s.clip) && s.stale === undefined) s.kept = true;
          writePlan(now);
        }
        approveStep(project, sub, step);
        const next = STEP_ORDER[STEP_ORDER.indexOf(step) + 1];
        if (next) run(next);
        break;
      }
      case "changes": requestChanges(project, sub, step, { text: a.text ?? "", scene: a.scene, at: a.at }); run(step); break;
      case "reopen": {
        this.starter.stop(project, sub);
        // A running job is left to finish and settle; only waiting jobs are cancelled. Nothing on disk is removed.
        const plan = readPlan(project, sub);
        for (const j of this.queue.list())
          if (j.params.studio?.project === plan.project && j.params.studio.sub === plan.sub && (j.status === "held" || j.status === "queued")) this.queue.cancel(j.id, "Step reopened by the owner. Nothing spent.");
        reopenStep(project, sub, step);
        break;
      }
      case "budget": setBudget(project, sub, step, a.credits ?? NaN); break;
      case "resume": {
        // Blocked (e.g. on budget) restarts the step; a paused run is un-paused; a live run is never doubled.
        const x = readSteps(project, sub).steps[step];
        if (x.status === "blocked") startStep(project, sub, step);
        else if (x.status === "working" && x.paused) resumeStep(project, sub, step);
        else throw new Error(`${step[0].toUpperCase() + step.slice(1)} ${x.status === "working" ? "is already working" : `cannot resume from ${x.status}`}.`);
        this.resumeStepJobs(project, sub, step); this.starter.start(project, sub, step);
        break;
      }
      case "start": {
        // Any idle step whose earlier steps are all approved (startStep checks those): Idea first, or a step after a reopen.
        if (readSteps(project, sub).steps[step].status !== "idle") throw new Error(`${step[0].toUpperCase() + step.slice(1)} is not idle.`);
        run(step);
        break;
      }
    }
    return readSteps(project, sub);
  }

  // The step whose owner-approved budget may pay for clips without a click: Look or Assets, working and not paused.
  // Returns it when the whole batch fits; otherwise blocks the step and throws before anything is queued.
  private fundBatch(project: string, sub: string, costs: number[]): StepName | undefined {
    const steps = readSteps(project, sub).steps;
    const step = (["look", "assets"] as const).find((n) => steps[n].status === "working" && !steps[n].paused);
    if (!step || !costs.length) return undefined;
    if (costs.some((c) => !Number.isInteger(c) || c < 0)) throw new Error("Inside a step budget max_credits must be a whole number, 0 or more.");
    const short = costs.reduce((a, c) => a + c, 0) - remaining(steps[step]);
    if (short > 0) {
      const msg = `needs ${short} more credits`;
      blockStep(project, sub, step, msg);
      throw new Error(msg);
    }
    return step;
  }

  // Each job is reserved as it is added, in one synchronous run (work() starts in a later microtask). fundBatch already
  // checked the total, so a refusal here means an id clash or a concurrent writer: the jobs added so far are cancelled
  // (their reservations settle at 0) and the error is passed on.
  private addFunded<T>(items: T[], step: StepName | undefined, add: (item: T) => Job): Job[] {
    const jobs: Job[] = [];
    try {
      for (const item of items) {
        const j = add(item);
        jobs.push(j);
        if (step) reserve(j.params.studio!.project, j.params.studio!.sub, step, j.id, j.params.max_credits);
      }
    } catch (e) {
      for (const j of jobs) this.queue.cancel(j.id, "Not queued: the step budget could not reserve this batch. Nothing spent.");
      throw e;
    }
    return jobs;
  }

  // Resolves what a job takes from earlier work just before it runs: the previous still (reference_previous) and the
  // last frame of the clip it continues from (chain_previous / a plan scene that starts as "continue").
  private async prepare(job: Job): Promise<void> {
    this.checkStudioJob(job);
    const { chain_from, chain_file, reference_from } = job.params;
    if (reference_from) {
      const still = this.queue.get(reference_from)?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
      if (!still) throw new Error(`reference_previous: the previous scene (${reference_from}) produced no image.`);
      const refs = job.params.reference_images ?? [];
      if (!refs.includes(still)) job.params.reference_images = [still, ...refs].slice(0, 3);
    }
    const clip = chain_file ?? (chain_from ? this.queue.get(chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f)) : undefined);
    if ((chain_from || chain_file) && !clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
    // Last line of defence for plan scenes (retry, transitive chains, anything not foreseen): a continue clip only
    // starts from its source scene's current, non-stale clip. Throws before the browser is touched - nothing spent.
    const st = job.params.studio;
    if (clip && st?.kind === "clip") {
      const plan = readPlan(st.project, st.sub);
      const me = plan.scenes.find((s) => s.n === st.scene);
      const start = me?.start;
      const from = start?.kind === "continue" ? plan.scenes.find((s) => s.n === start.from) : undefined;
      if (from && (from.clip !== clip || from.stale))
        throw new Error(`Scene ${from.n} changed after this was approved - redo scene ${st.scene}. Nothing spent.`);
    }
    if (clip) job.params.first_frame = await this.lastFrame(clip);
  }

  private checkStudioJob(job: Job): void {
    const st = job.params.studio;
    if (!st) return;
    const plan = readPlan(st.project, st.sub);
    const scene = plan.scenes.find((s) => s.n === st.scene);
    if (!scene || !st.input || st.input !== sceneInput(plan, scene, st.kind) || (st.kind === "clip" && !scene.approved))
      throw new Error(`Scene ${st.scene} changed or is not approved - approve the scene and queue it again. Nothing spent.`);
  }

  // Every finished job records where its media sits in Flow (account + project), so edits and continues find it.
  private defaultRunner: JobRunner = async (job) => {
    const files = await this.runJob(job);
    job.flow = await currentLocation(await getFlowPage()).catch(() => undefined);
    return files;
  };

  private async runJob(job: Job): Promise<string[]> {
    // An edit or continue must run where its source clip is: a same-named clip in another account would be edited
    // (and charged) instead. Unknown source -> refused before the browser is touched.
    const source = job.params.edit_asset ?? job.params.continue_from;
    if (source) {
      const loc = findSource(this.queue.list(), source);
      await goToSource(await getFlowPage(), loc, ACCOUNTS_FILE);
    } else if (job.params.agent_ref_assets?.length) {
      if (!job.flow) throw new Error("Cached agent assets have no verified source Flow project. Review the failed batch before retrying; nothing was generated.");
      await goToSource(await getFlowPage(), job.flow, ACCOUNTS_FILE);
      await ensureJobProject(await getFlowPage(), job);
    } else await ensureJobProject(await getFlowPage(), job);
    if (job.params.continue_from) return runContinue(job);
    if (job.params.agent_scenes) {
      // Bind before uploads so even a failed batch can safely reuse its cached assets on retry.
      const location = await currentLocation(await getFlowPage());
      if (!location) throw new Error("The Flow account and project for this agent batch could not be verified.");
      job.flow = location;
      return runAgentBatch(job);
    }
    if (job.params.edit_asset) return runEdit(job);
    return runGeneration(job, (page) => ensureAffordable(page, job, ACCOUNTS_FILE, this.queue));
  }

  async status({ detailed }: Args<"status">) {
    const flow = await getFlowState(detailed && !this.queue.busy);
    return { flow, pacing: this.queue.pausedReason, output_root: OUTPUT_ROOT, jobs: this.queue.list().map(jobView) };
  }

  async generate({ project, scenes }: Args<"generate">) {
    const batch = randomUUID().slice(0, 8); // one OK releases the whole call
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
    if (noPrev >= 0) throw new Error("Scene 1 has no previous scene to reference.");
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);

    const output_dir = projectDir(project);
    // Continue numbering after whatever is already on disk or queued, so reruns never overwrite earlier scenes.
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    const offset = Math.max(0, ...onDisk, ...queued);
    const jobs: Job[] = [];
    for (const [i, { chain_previous, reference_previous, technique, ...scene }] of scenes.entries()) {
      const phrase = technique ? techniqueById(technique)!.phrase : "";
      // A referenced character must come out identical, not merely similar, so the scene says so explicitly. The
      // wording stays medium-neutral: the same lock has to serve a flat cartoon character and a photoreal avatar.
      const cast = (scene.reference_images ?? [])
        .filter((r) => r.startsWith("asset:"))
        .map((r) => r.slice(6).trim())
        .filter((n) => characterLook(n) !== undefined || /^[\w .'-]{1,60}$/.test(n));
      const lock = cast.length
        ? ` CHARACTER LOCK — ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions, same clothing items in the same colours, same hands, and the same rendering style and level of realism as the reference. Never redesign, restyle, re-proportion, re-age or re-colour them, and never swap an item for a similar one.${cast
            .map((n) => (characterLook(n) ? ` ${n} is exactly: ${characterLook(n)}.` : ""))
            .join("")}`
        : "";
      const inherit = reference_previous
        ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later."
        : "";
      jobs.push(
        this.queue.add({
          ...scene,
          prompt: `${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lock}${inherit}`,
          chain_from: chain_previous ? jobs[i - 1].id : undefined,
          reference_from: reference_previous ? jobs[i - 1].id : undefined,
          output_dir,
          file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
        }, { batch }),
      );
    }
    return { output_dir, batch, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running" && j.status !== "held"),
      awaiting_approval: jobs.filter((j) => j.status === "held").map((j) => j.id),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job with id ${job_id}. Use flow_status to list jobs.`);
    return jobView(job);
  }

  async retry({ job_ids }: Args<"retry">) {
    const ids = job_ids ?? this.queue.list().filter((j) => j.status === "failed" || j.failed_scenes?.length).map((j) => j.id);
    const jobs: Job[] = [];
    for (const id of ids) {
      const job = this.queue.get(id);
      const p = job?.params;
      if (job?.failed_scenes?.length && p?.agent_scenes && job.status === "done") {
        // A batch that finished with some images still failed: make just those again, under their own scene numbers,
        // instead of re-running the whole batch. The list moves to the new job, so it is never retried twice.
        const base = Number(p.file_stem.match(/\d+/)?.[0] ?? 1);
        const numbers = p.agent_numbers ?? p.agent_scenes.map((_, i) => base + i);
        const pick = job.failed_scenes.map((n) => numbers.indexOf(n)).filter((i) => i >= 0);
        job.failed_scenes = undefined;
        jobs.push(
          this.queue.add({
            ...p,
            prompt: `Agent batch: ${pick.length} failed image(s) again`,
            agent_scenes: pick.map((i) => p.agent_scenes![i]),
            agent_numbers: pick.map((i) => numbers[i]),
            agent_scene_refs: p.agent_scene_refs ? pick.map((i) => p.agent_scene_refs![i]) : undefined,
            file_stem: `scene-${String(numbers[pick[0]]).padStart(2, "0")}`,
          }, { flow: job.flow }),
        );
        continue;
      }
      const again = this.queue.retry(id);
      if (again) jobs.push(again);
    }
    if (!jobs.length) throw new Error("Nothing to retry: no failed jobs, and no batch with failed images.");
    return { jobs: jobs.map(jobView) };
  }

  async assets({ kind }: Args<"assets">) {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind }) => ({ name, kind }));
  }

  async download({ project, assets, quality }: Args<"download">) {
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    // Numbering from 1 every call overwrote clips fetched earlier - it destroyed a finished shot once. Carry on from
    // the highest clip-NN already on disk instead.
    let next = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^clip-(\d+)/)?.[1] ?? 0))) + 1;
    for (const name of assets) {
      try {
        files.push(...(await downloadAsset(name, join(dir, `clip-${String(next++).padStart(2, "0")}`), quality)));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
      }
    }
    return { dir, files };
  }

  async assemble({ project, voice_lines, ...rest }: Args<"assemble">) {
    const dir = projectDir(project);
    if (!voice_lines?.length) return assemble({ dir, ...rest });
    mkdirSync(dir, { recursive: true });
    const track = await voiceTrack(voice_lines, join(dir, `${rest.output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`));
    const film = await assemble({ dir, ...rest, voiceover: track.file });
    return { ...film, voice: track };
  }

  // Captions never touch Flow or its queue: whisper.cpp hears the words, a headless Chrome of its own draws them.
  async transcribe({ video, language, words }: Args<"transcribe">) {
    const t = await transcribe(video, language);
    return {
      text: t.text,
      word_count: t.words.length,
      language: t.language,
      model: t.model,
      ...(words ? { words: t.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
    };
  }

  async caption_preview(a: Args<"caption_preview">) {
    return previewCaptions(a.video, a);
  }

  async captions({ project, ...a }: Args<"captions">) {
    // Save next to the video when it is already one of the user's films, otherwise in a Captions folder.
    const rel = relative(OUTPUT_ROOT, dirname(a.video));
    const inFilms = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    const dir = project ? projectDir(project) : inFilms ? dirname(a.video) : projectDir("Captions");
    mkdirSync(dir, { recursive: true });
    return burnCaptions(a.video, a, captionedName(dir, a.video));
  }

  async caption_setup() {
    return captionSetup();
  }

  async studio_projects() { return listProjects(); }
  // What the owner has open in the studio page. Harmless, so any caller may set it; kept in memory and on disk.
  async studio_select({ project, sub }: Args<"studio_select">) {
    this.selection = { project: safeName(project), sub: safeName(sub) };
    writeJsonAtomic(SELECTION_FILE, this.selection);
    return { ok: true };
  }
  async studio_current() { return this.selection; }
  async studio_context_read() { return { context: this.uiContext.read() }; }
  async studio_guide_read(a: Args<"studio_guide_read">) { return readCreativeGuide(a.stage); }
  validateUiContext(raw: unknown): UiContext {
    const context = UiContextSchema.parse(raw);
    const plan = readPlan(context.project, context.sub), item = context.selection;
    if (item?.kind === "render") {
      if (!listRenders(context.project, context.sub).some(r => r.version === item.version)) throw new Error("The selected render no longer exists.");
    } else if (item) {
      const scene = plan.scenes.find(s => s.n === item.scene);
      if (!scene) throw new Error("The selected scene no longer exists.");
      if (item.kind === "take" && !this.takeHistory(context.project, context.sub, scene)[item.takeIndex - 1]) throw new Error("The selected take no longer exists.");
    }
    return context;
  }
  publishUiContext(raw: unknown) {
    const input = UiPublicationSchema.parse(raw);
    this.validateUiContext(input.context);
    return this.uiContext.publish(input);
  }
  async studio_workflow_read(a: Args<"studio_workflow_read">) {
    const { project, sub } = this.pick(a), plan = readPlan(project, sub);
    const file = (path?: string) => { try { return !!path && statSync(path).isFile(); } catch { return false; } };
    const active = (n: number) => this.queue.list().some(j => j.params.studio?.project === project && j.params.studio.sub === sub && j.params.studio.scene === n && ["held", "queued", "running"].includes(j.status));
    return deriveWorkflow({ plan, scenes: plan.scenes.map(s => ({
      n: s.n, validPlan: !!s.prompt.trim(),
      validSource: s.start?.kind !== "continue" || (s.start.from < s.n && plan.scenes.some(source => source.n === (s.start as { from: number }).from)),
      storyboardExists: file(s.storyboard), clipExists: file(s.clip), hasTakes: this.takeHistory(project, sub, s).length > 0, hasActiveJob: active(s.n),
    })), renderVersions: listRenders(project, sub).map(r => r.version), editTaskPhase: readEdit(project, sub)?.phase ?? null });
  }
  private pickProject(p?: string): string {
    const r = p ?? this.selection?.project;
    if (!r) throw new Error(NO_SELECTION);
    return r;
  }
  // Omitted project/sub fall back to the owner's selection (a sub only if it belongs to the same project).
  private pick(a: { project?: string; sub?: string }): { project: string; sub: string } {
    const project = this.pickProject(a.project);
    const sub = a.sub ?? (this.selection?.project === project ? this.selection.sub : undefined);
    if (!sub) throw new Error(`sub is required for project ${project} (the studio has ${this.selection ? this.selection.project + "/" + this.selection.sub : "nothing"} selected).`);
    return { project, sub };
  }
  async studio_references(a: Args<"studio_references">) {
    const { project, sub } = this.pick(a);
    const ls = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => statSync(join(d, f)).isFile()).map((f) => join(d, f)) : []);
    const shared = ls(join(projDir(project), "references")), local = ls(join(subDir(project, sub), "references"));
    const active = [...new Set(readPlan(project, sub).references ?? [])];
    return { project: shared, sub: local, active, library: [...shared, ...local].filter(path => !active.includes(path)) };
  }
  async studio_new({ project, sub, aspect }: Args<"studio_new">) { return { dir: createSub(project, sub, aspect) }; }
  async studio_plan_read(a: Args<"studio_plan_read">) {
    const { project, sub } = this.pick(a);
    const lessons = readLessons();
    const note = lessons.length > 60 ? `Lessons has ${lessons.length} rules - propose merges to the owner.` : undefined;
    const plan = readPlan(project, sub);
    return { ...plan, rev: plan.rev ?? 0, lessons, creative_guide: creativeGuideInfo(), ...(note && { note }) };
  }
  // Only proposes: nothing reaches the rulebook until the owner approves in the studio page.
  async studio_propose_lesson({ text, scope }: Args<"studio_propose_lesson">) { return proposeLesson(text, scope); }
  // Walks the signed-in Google accounts in the Flow tab (read-only, 0 credits). The queue is held meanwhile so no job
  // drives the same tab; emails stay out of the answer.
  async studio_accounts_refresh() {
    if (this.queue.busy) throw new Error(BUSY);
    const prior = this.queue.pausedReason;
    const hold = !prior || prior.startsWith("pacing:");
    if (hold) this.queue.pause(READING_ACCOUNTS);
    try {
      const accounts = await discoverAccounts(await getFlowPage(), ACCOUNTS_FILE);
      return accounts.map(({ index, credits, refreshTime, exhaustedUntil }) => ({ index, credits, refreshTime, exhaustedUntil }));
    } finally {
      // Something else (all accounts out of credits, the owner) may have paused it meanwhile: leave that pause alone.
      if (hold && this.queue.pausedReason === READING_ACCOUNTS) this.queue.resume();
    }
  }
  async studio_plan_write(a: Args<"studio_plan_write">) {
    const { project, sub } = this.pick(a); const { rev, plan } = a;
    const old = (() => { try { return readPlan(project, sub); } catch { return undefined; } })();
    if (rev !== (old?.rev ?? 0)) throw new Error("Plan changed since you read it — call studio_plan_read again.");
    const refRoots = [join(projDir(project), "references"), join(subDir(project, sub), "references"), uploadsDir()];
    // Omission in an older client must not turn an explicit selection back into shared inheritance.
    const adReferences = plan.references ?? old?.references;
    for (const r of adReferences ?? []) if (!within(r, refRoots)) throw new Error(`Ad reference ${r} must be inside the project's references folder or the uploads folder.`);
    for (const s of plan.scenes) for (const r of s.references ?? [])
      if (!within(r, refRoots)) throw new Error(`Scene ${s.n}: reference ${r} must be inside the project's references folder or the uploads folder (use studio_add_reference).`);
    for (const s of plan.scenes) {
      if (s.start?.kind !== "continue") continue;
      const from = s.start.from;
      if (from >= s.n) throw new Error(`Scene ${s.n}: start.from must be an earlier scene (got ${from}).`);
      const source = plan.scenes.find((x) => x.n === from);
      if (!source) throw new Error(`Scene ${s.n}: start.from ${from} is not a scene in this plan.`);
      if (isStill(source)) throw new Error(`Scene ${s.n} continues from a still (scene ${from}); a continuation needs a clip as its source.`);
    }
    if (plan.chosen !== undefined && !(plan.options ?? []).some((o) => o.id === plan.chosen)) throw new Error(`chosen "${plan.chosen}" is not one of the options' ids.`);
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const scenes = plan.scenes.map((s) => {
      const o = old?.scenes.find((x) => x.n === s.n);
      // storyboard/clip/stale are engine-owned (recorded by finished jobs) and approved/kept are the owner's
      // (UI token routes): whatever the caller sends for them is ignored.
      const { approved: _a, kept: _k, storyboard: _s, clip: _c, storyboard_flow: _sf, clip_flow: _cf, stale: _st, takes: _takes, ...rest } = s;
      if (!o) return rest;
      // Approval belongs to what was approved: changing the content clears it.
      const changed = s.prompt !== o.prompt || s.camera !== o.camera || s.frame_prompt !== o.frame_prompt || !same(s.start ?? { kind: "frame" }, o.start ?? { kind: "frame" }) || !same(s.references ?? [], o.references ?? []) || !same(adReferences, old?.references);
      return { ...rest, storyboard: o.storyboard, clip: o.clip, storyboard_flow: o.storyboard_flow, clip_flow: o.clip_flow, takes: o.takes, stale: rest.start?.kind === "continue" ? o.stale : undefined, approved: changed ? false : o.approved, kept: o.kept };
    });
    writePlan({ ...plan, references: adReferences, scenes, project: safeName(project), sub: safeName(sub) });
    const current = readPlan(project, sub);
    for (const job of this.queue.list()) {
      const st = job.params.studio;
      if (st?.project !== safeName(project) || st.sub !== safeName(sub) || !["held", "queued"].includes(job.status)) continue;
      const scene = current.scenes.find((s) => s.n === st.scene);
      if (!scene || st.input !== sceneInput(current, scene, st.kind) || (st.kind === "clip" && !scene.approved))
        this.queue.cancel(job.id, `Scene ${st.scene} changed - approve the scene and queue it again. Nothing spent.`);
    }
    return { ok: true, rev: planRev(project, sub) };
  }
  async studio_add_reference(a: Args<"studio_add_reference">) { return { path: addReference(this.pickProject(a.project), a.sub, a.path) }; }
  async studio_notes_read(a: Args<"studio_notes_read">) {
    const { project, sub } = this.pick(a); const text = readNotes(project, sub); return { text, rev: notesRev(text) }; }
  async studio_edit_notes_read(a: Args<"studio_edit_notes_read">) {
    const { project, sub } = this.pick(a); const text = readNotes(project, sub, "edit-notes.md"); return { text, rev: notesRev(text) }; }
  async studio_edit_notes_write(a: Args<"studio_edit_notes_write">) {
    const { project, sub } = this.pick(a);
    return { ok: true, rev: writeNotes(project, sub, a.text, a.rev, "edit-notes.md") };
  }
  async studio_render_done(a: Args<"studio_render_done">) {
    const { project, sub } = this.pick(a);
    const task = readEdit(project, sub);
    if (a.task_id && task?.id === a.task_id && task.phase === "finished" && task.render && resolve(a.file).toLowerCase() === resolve(task.render.path).toLowerCase()) return task.render;
    if ((a.task_id && (task?.id !== a.task_id || !activeEdit(task))) || (activeEdit(task) && !a.task_id))
      throw new Error("Render task_id does not match an active editing task. Read the current task before registering a render.");
    const render = renderDone(project, sub, a.file);
    if (a.task_id) finishEdit(project, sub, a.task_id, render);
    return render;
  }
  async studio_edit_task_read(a: Args<"studio_edit_task_read">) {
    const scope = this.pick(a); let task = readEdit(scope.project, scope.sub);
    if (task && activeEdit(task) && task.session !== this.editSession)
      task = updateEdit(scope.project, scope.sub, task.id, "failed", "Studio restarted during this task. Review the terminal and renders before starting again.");
    return { task };
  }
  async studio_edit_task_update(a: Args<"studio_edit_task_update">) {
    const { project, sub } = this.pick(a);
    return { task: updateEdit(project, sub, a.task_id, a.phase, a.message) };
  }
  startEditTask(a: { project: string; sub: string }) {
    const scope = this.pick(a), plan = readPlan(scope.project, scope.sub);
    if (!plan.scenes.some((s) => s.kept && s.clip)) throw new Error("Keep at least one clip before editing.");
    if (plan.scenes.some((s) => s.kept && s.stale !== undefined)) throw new Error("Redo stale kept scenes before editing.");
    this.editScopes.set(scope.project + "/" + scope.sub, scope);
    return startEdit(scope.project, scope.sub, this.editSession);
  }
  stopEditTask(a: { project: string; sub: string; task_id: string }) {
    const { project, sub } = this.pick(a);
    return updateEdit(project, sub, a.task_id, "failed", "Marked stopped by the owner. This does not stop a running agent or render; check the terminal before retrying.");
  }
  interruptEditTasks(message: string) {
    for (const { project, sub } of this.editScopes.values()) {
      const task = readEdit(project, sub);
      if (task?.session === this.editSession && activeEdit(task)) updateEdit(project, sub, task.id, "failed", message);
    }
  }
  async studio_renders(a: Args<"studio_renders">) { const { project, sub } = this.pick(a); return { renders: listRenders(project, sub) }; }
  async studio_step_read(a: Args<"studio_step_read">) {
    const { project, sub } = this.pick(a); const st = readSteps(project, sub);
    const step = STEP_ORDER.find((n) => st.steps[n].status !== "approved") ?? null, x = step && st.steps[step];
    return { step, status: x ? x.status : "approved", paused: !!x?.paused, budget: x?.budget ?? 0, remaining: x ? remaining(x) : 0, feedback: x?.feedback ?? [], steps: STEP_ORDER.map((name) => ({ name, status: st.steps[name].status })), rev: st.rev };
  }
  async studio_step_submit(a: Args<"studio_step_submit">) {
    const { project, sub } = this.pick(a);
    const active = this.queue.list().filter((j) => j.params.studio?.project === project && j.params.studio.sub === sub && j.params.studio.step === a.step && ["held", "queued", "running"].includes(j.status)).length;
    if (active) throw new Error(`${active} jobs still running`);
    if (a.picks?.length) {
      const scenes = readPlan(project, sub).scenes;
      for (const p of a.picks) {
        const s = scenes.find((x) => x.n === p.scene);
        if (!s || (p.clip !== s.clip && !this.takeHistory(project, sub, s).some((t) => t.clip === p.clip))) throw new Error(`Scene ${p.scene}: that clip is not one of its takes.`);
      }
    }
    return submitStep(project, sub, a.step, { summary: a.summary, flags: a.flags ?? [], picks: a.picks });
  }
  async studio_step_blocked(a: Args<"studio_step_blocked">) { const { project, sub } = this.pick(a); return blockStep(project, sub, a.step, a.reason); }
  async studio_production_plan_read(a: Args<"studio_production_plan_read">) {
    const { project, sub } = this.pick(a); const text = readNotes(project, sub, "production-plan.md"); return { text, rev: notesRev(text) }; }
  async studio_production_plan_write(a: Args<"studio_production_plan_write">) {
    const { project, sub } = this.pick(a);
    return { ok: true, rev: writeNotes(project, sub, a.text, a.rev, "production-plan.md") };
  }
  async studio_notes_write(a: Args<"studio_notes_write">) {
    const { project, sub } = this.pick(a); const { text, rev } = a;
    return { ok: true, rev: writeNotes(project, sub, text, rev) };
  }

  private recordDone(job: Job): void {
    const st = job.params.studio;
    if (!st || !job.files[0]) return;
    const plan = readPlan(st.project, st.sub);
    const scene = plan.scenes.find((x) => x.n === st.scene);
    if (!scene) return;
    if (st.input !== sceneInput(plan, scene, st.kind)) {
      job.note = "Finished file preserved, but the scene changed while generating; result was not attached to the plan.";
      return;
    }
    if (st.kind === "clip") {
      scene.takes ??= [];
      if (scene.clip && !scene.takes.some((t) => t.clip === scene.clip)) scene.takes.push({ clip: scene.clip, flow: scene.clip_flow });
      if (!scene.takes.some((t) => t.clip === job.files[0])) scene.takes.push({ clip: job.files[0], flow: job.flow, fromClip: this.chainedClip(job), createdAt: new Date().toISOString() });
      if (scene.clip !== job.files[0]) scene.kept = false;
    }
    scene[st.kind] = job.files[0];
    scene[`${st.kind}_flow`] = job.flow;
    if (st.kind === "storyboard") scene.approved = false; // a new still must be looked at again
    else this.clipChanged(plan, scene, job);
    writePlan(plan);
  }

  // The clip a chained job started from (its source job's video, or a finished clip on disk).
  private chainedClip(j: Job): string | undefined {
    return j.params.chain_file ?? (j.params.chain_from ? this.queue.get(j.params.chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f)) : undefined);
  }

  restoreTake(a: { project: string; sub: string; scene: number; clip: string }) {
    const { project, sub } = this.pick(a), plan = readPlan(project, sub);
    const scene = plan.scenes.find((s) => s.n === a.scene);
    const history = scene ? this.takeHistory(project, sub, scene) : [];
    const take = history.find((t) => t.clip === a.clip);
    if (!scene || !take || !within(take.clip, [clipsDir(project, sub)]) || !existsSync(take.clip)) throw new Error("That take is not available for this scene.");
    if (this.studioJobs(project, sub, "clip", scene.n).some((j) => ["held", "queued", "running"].includes(j.status))) throw new Error("Finish or cancel this scene's active job before restoring a take.");
    if (scene.clip === take.clip) return { ok: true };
    scene.takes = history;
    scene.clip = take.clip; scene.clip_flow = take.flow; scene.kept = false;
    this.clipChanged(plan, scene, { id: "restored", files: [take.clip], params: { chain_file: take.fromClip } } as Job);
    writePlan(plan); return { ok: true };
  }

  // A clip for scene N just finished (redo or generate). Only now has N really changed, so a cancelled or never-approved
  // redo changes nothing. Mutates plan; the caller writes it.
  private clipChanged(plan: ReturnType<typeof readPlan>, scene: ReturnType<typeof readPlan>["scenes"][number], job: Job): void {
    // This clip joins its source only if it started on the source scene's current clip.
    if (scene.start?.kind === "continue") {
      const from = scene.start.from;
      const current = plan.scenes.find((x) => x.n === from)?.clip;
      if (current && this.chainedClip(job) === current) delete scene.stale;
      else scene.stale = scene.stale ?? from;
    } else delete scene.stale;
    // Every scene continuing from this one (directly or through others) with a clip no longer joins it.
    const deps: number[] = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const x of plan.scenes)
        if (x.start?.kind === "continue" && (x.start.from === scene.n || deps.includes(x.start.from)) && !deps.includes(x.n)) { deps.push(x.n); grew = true; }
    }
    for (const x of plan.scenes) if (deps.includes(x.n) && x.clip) x.stale = scene.n;
    // Held or queued clips of the direct dependents that would start on an older clip of this scene: cancelled before
    // they spend anything (theirs in turn by the queue). Waiting on a newer, still-live take of this scene is fine.
    const live = (id?: string) => { const s = id ? this.queue.get(id)?.status : undefined; return s === "held" || s === "queued" || s === "running"; };
    for (const x of plan.scenes) {
      if (x.start?.kind !== "continue" || x.start.from !== scene.n) continue;
      for (const j of this.studioJobs(plan.project, plan.sub, "clip", x.n)) {
        if (j.status !== "held" && j.status !== "queued") continue;
        const p = j.params;
        const outdated = (p.chain_file !== undefined && p.chain_file !== job.files[0]) || (p.chain_from !== undefined && p.chain_from !== job.id && !live(p.chain_from));
        if (outdated) this.queue.cancel(j.id, `Scene ${scene.n} changed after this was approved - redo it. Nothing spent.`);
      }
    }
  }

  private studioJobs(project: string, sub: string, kind: "storyboard" | "clip", scene: number) {
    return this.queue.list().filter((j) => j.params.studio?.project === project && j.params.studio.sub === sub && j.params.studio.kind === kind && j.params.studio.scene === scene);
  }

  private takeHistory(project: string, sub: string, scene: ReturnType<typeof readPlan>["scenes"][number]) {
    const entries = [...(scene.takes ?? []), ...this.studioJobs(project, sub, "clip", scene.n)
      .filter((j) => j.status === "done" && j.files[0]).map((j) => ({ clip: j.files[0], flow: j.flow, fromClip: this.chainedClip(j), createdAt: j.finishedAt })),
      ...(scene.clip ? [{ clip: scene.clip, flow: scene.clip_flow }] : [])];
    return entries.filter((take, index) => entries.findIndex((x) => x.clip === take.clip) === index && within(take.clip, [clipsDir(project, sub)]) && existsSync(take.clip));
  }

  // First free stem: scene-NN, then scene-NN<sep>2, <sep>3... Never reuses a name on disk or in a live job.
  private freeStem(dir: string, project: string, sub: string, kind: "storyboard" | "clip", n: number): string {
    const base = `scene-${String(n).padStart(2, "0")}`;
    const sep = kind === "clip" ? "-take-" : "-v";
    const used = new Set([
      ...(existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.[^.]+$/, "")) : []),
      ...this.studioJobs(project, sub, kind, n).filter((j) => j.status !== "failed" && j.status !== "cancelled").map((j) => j.params.file_stem),
    ]);
    let stem = base;
    for (let k = 2; used.has(stem); k++) stem = `${base}${sep}${k}`;
    return stem;
  }

  private studioRefs(plan: ReturnType<typeof readPlan>, scene: { references?: string[] }): string[] {
    return [...new Set([...(scene.references ?? []), ...(plan.references ?? [])].map(r => resolve(r)))];
  }

  // approvedOnly applies to an explicit list too: unapproved scenes are skipped and reported, never queued.
  private pickScenes(plan: ReturnType<typeof readPlan>, scenes: number[] | undefined, approvedOnly: boolean) {
    const all = scenes
      ? [...new Set(scenes)].map((n) => {
        const s = plan.scenes.find((x) => x.n === n);
        if (!s) throw new Error(`Unknown scene ${n}.`);
        return s;
      })
      : plan.scenes;
    const picked = all.filter((s) => !approvedOnly || s.approved === true);
    const skipped = all.filter((s) => !picked.includes(s)).map((s) => s.n);
    if (!picked.length) throw new Error(approvedOnly ? "No approved scenes - approve storyboard frames first." : "Plan has no scenes.");
    return { picked, skipped };
  }

  // Where a "continue" scene's first frame comes from: the source scene's job in this batch, else its live (not yet
  // finished) clip job, else its finished clip on disk. Nothing to continue from -> refused before anything is queued.
  private chainSource(plan: ReturnType<typeof readPlan>, from: number, inBatch: Map<number, Job>): Pick<SceneParams, "chain_from" | "chain_file"> {
    const here = inBatch.get(from);
    if (here) return { chain_from: here.id };
    const live = this.studioJobs(plan.project, plan.sub, "clip", from).filter((j) => ["held", "queued", "running"].includes(j.status)).at(-1);
    if (live) return { chain_from: live.id };
    const clip = plan.scenes.find((x) => x.n === from)?.clip;
    if (clip) return { chain_file: clip };
    throw new Error(`Scene ${from} has no clip yet, and a scene continues from it: generate scene ${from} in the same batch or first.`);
  }

  private clipCost(scene: ReturnType<typeof readPlan>["scenes"][number], a: { duration?: 4 | 6 | 8 | 10; resolution?: "360p" | "720p"; model?: string; max_credits?: number }) {
    return a.max_credits ?? sceneSettings(scene, a).max_credits;
  }

  private clipJob(plan: ReturnType<typeof readPlan>, scene: ReturnType<typeof readPlan>["scenes"][number], a: { duration?: 4 | 6 | 8 | 10; resolution?: "360p" | "720p"; model?: string; max_credits?: number; prompt?: string }, batch: string, inBatch = new Map<number, Job>(), step?: StepName) {
    const set = sceneSettings(scene, a);
    const dir = clipsDir(plan.project, plan.sub);
    const from = scene.start?.kind === "continue" ? scene.start.from : undefined;
    const params: SceneParams = {
      prompt: a.prompt ?? scene.prompt, type: "video", max_credits: this.clipCost(scene, a), duration: set.duration, resolution: set.resolution, model: set.model,
      aspect_ratio: plan.aspect,
      // A continue scene's first frame is filled in just before it runs (prepare), from its source clip's last frame.
      ...(from === undefined ? { first_frame: scene.storyboard } : this.chainSource(plan, from, inBatch)),
      reference_images: this.studioRefs(plan, scene),
      output_dir: dir, file_stem: this.freeStem(dir, plan.project, plan.sub, "clip", scene.n),
      studio: { project: plan.project, sub: plan.sub, scene: scene.n, kind: "clip", input: sceneInput(plan, scene, "clip"), ...(from !== undefined && { from }), ...(step && { step }) },
    };
    return this.queue.add(params, { batch, preapproved: !!step });
  }

  async studio_storyboard(a: Args<"studio_storyboard">) {
    const { project, sub } = this.pick(a); const { scenes } = a;
    const plan = readPlan(project, sub);
    const dir = join(subDir(project, sub), "storyboard");
    const picked = this.pickScenes(plan, scenes, false).picked;
    // A continue scene has no still of its own: its first frame is the last frame of the clip it continues from.
    const continues = picked.filter((s) => s.start?.kind === "continue").map((s) => s.n);
    const already_queued = picked.filter((s) => this.studioJobs(project, sub, "storyboard", s.n).some((j) => ["held", "queued", "running"].includes(j.status))).map((s) => s.n);
    const own = picked.filter((s) => s.start?.kind !== "continue" && !already_queued.includes(s.n));
    const noFrame = own.filter((s) => !s.frame_prompt?.trim()).map((s) => s.n);
    const job_ids = own.map((s) => this.queue.add({
      prompt: s.frame_prompt?.trim() || s.prompt, type: "image", max_credits: 0, aspect_ratio: plan.aspect,
      reference_images: this.studioRefs(plan, s),
      output_dir: dir, file_stem: this.freeStem(dir, plan.project, plan.sub, "storyboard", s.n),
      studio: { project: plan.project, sub: plan.sub, scene: s.n, kind: "storyboard", input: sceneInput(plan, s, "storyboard") },
    }).id);
    return {
      job_ids,
      already_queued,
      ...(continues.length && { skipped_continue: continues }),
      ...(noFrame.length && { note: `Scene(s) ${noFrame.join(", ")} have no frame_prompt, so the clip prompt was drawn instead. Add a frame_prompt (what the still shows) to each scene with studio_plan_write.` }),
    };
  }

  async studio_generate(a: Args<"studio_generate">) {
    const { project, sub } = this.pick(a); const { scenes, duration, resolution, model, max_credits } = a;
    const plan = readPlan(project, sub);
    const selection = this.pickScenes(plan, scenes, true);
    const skipped = selection.skipped;
    // A still scene's image is its final asset: no video job, no credits reserved.
    const skipped_stills = selection.picked.filter(isStill).map((s) => s.n);
    const already_queued = selection.picked.filter((s) => !isStill(s)).filter((s) => this.studioJobs(project, sub, "clip", s.n).some((j) => ["held", "queued", "running"].includes(j.status))).map((s) => s.n);
    const picked = selection.picked.filter((s) => !isStill(s) && !already_queued.includes(s.n));
    // Sources first (start.from is always an earlier n), and every continue checked before anything is queued.
    picked.sort((x, y) => x.n - y.n);
    const ns = new Set(picked.map((s) => s.n));
    for (const s of picked) if (s.start?.kind === "continue" && !ns.has(s.start.from)) this.chainSource(plan, s.start.from, new Map());
    const step = this.fundBatch(project, sub, picked.map((s) => this.clipCost(s, { duration, resolution, model, max_credits })));
    const batch = randomUUID().slice(0, 8);
    const inBatch = new Map<number, Job>();
    const jobs = this.addFunded(picked, step, (s) => { const j = this.clipJob(plan, s, { duration, resolution, model, max_credits }, batch, inBatch, step); inBatch.set(s.n, j); return j; });
    return { batch, ...(step ? { queued: picked.length, step, held: 0 } : { held: picked.length }), already_queued, quoted_max_credits: jobs.reduce((n, j) => n + j.params.max_credits, 0), ...(skipped.length && { skipped_unapproved: skipped }), ...(skipped_stills.length && { skipped_stills }) };
  }

  async studio_redo(a: Args<"studio_redo">) {
    const { project, sub } = this.pick(a); const { scene, prompt, duration, resolution, model } = a;
    const plan = readPlan(project, sub);
    if (plan.scenes.some((x) => x.n === scene && isStill(x))) throw new Error(`Scene ${scene} is a still; redo its image with studio_storyboard`);
    const s = this.pickScenes(plan, [scene], true).picked[0];
    const existing = this.studioJobs(project, sub, "clip", scene).find((j) => ["held", "queued", "running"].includes(j.status));
    if (existing) return { batch: existing.batch, held: 0, already_queued: [scene], job_id: existing.id, quoted_max_credits: 0 };
    const step = this.fundBatch(project, sub, [this.clipCost(s, { duration, resolution, model })]);
    const batch = randomUUID().slice(0, 8);
    const [job] = this.addFunded([s], step, (x) => this.clipJob(plan, x, { duration, resolution, model, prompt }, batch, new Map(), step));
    return { batch, ...(step ? { queued: 1, step, held: 0 } : { held: 1 }), job_id: job.id, quoted_max_credits: job.params.max_credits };
  }

  async studio_status(a: Args<"studio_status">) {
    const { project, sub } = this.pick(a);
    const plan = readPlan(project, sub);
    const mine = this.queue.list().filter((j) => j.params.studio?.project === plan.project && j.params.studio.sub === plan.sub);
    return {
      scenes: plan.scenes.map((s) => ({
        n: s.n, storyboard: s.storyboard, approved: s.approved, clip: s.clip, kept: s.kept, start: s.start, stale: s.stale,
        takes: this.takeHistory(project, sub, s),
        jobs: mine.filter((j) => j.params.studio!.scene === s.n).map((j) => ({ id: j.id, kind: j.params.studio!.kind, status: j.status, batch: j.batch, credits: j.credits, note: j.note, error: j.error })),
      })),
      pending: this.queue.pendingApproval().filter((g) => g.jobs.some((j) => j.params.studio?.project === plan.project && j.params.studio.sub === plan.sub)),
      steps: readSteps(project, sub),
      production_plan: await this.studio_production_plan_read({ project, sub }),
    };
  }

  async studio_to_remotion(a: Args<"studio_to_remotion">) {
    const { project, sub } = this.pick(a); const { music, voiceover } = a;
    const plan = readPlan(project, sub);
    for (const [what, p] of [["music", music], ["voiceover", voiceover]] as const)
      if (p && !within(p, [uploadsDir()])) throw new Error(`${what} must be a file uploaded through the studio page (inside the uploads folder).`);
    const clips = clipsDir(project, sub);
    for (const s of plan.scenes) if (s.kept && !isStill(s) && s.clip && !within(s.clip, [clips])) throw new Error(`Scene ${s.n}: kept clip must be inside ${clips}.`);
    return { ...handoff(plan, { music, voiceover }), style: plan.style };
  }

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { root: OUTPUT_ROOT, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
    const projects = readdirSync(OUTPUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(OUTPUT_ROOT, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root: OUTPUT_ROOT, projects };
  }

  private nextStem(output_dir: string, prefix: string): string {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix)).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
  }

  async agent({ project, scenes, aspect_ratio, download_quality, references, scene_references }: Args<"agent">) {
    const output_dir = projectDir(project);
    if (scene_references && scene_references.length !== scenes.length) {
      throw new Error(`scene_references has ${scene_references.length} entries for ${scenes.length} scenes; give one list per scene (empty for none).`);
    }
    const known = new Set((references ?? []).map((r) => r.name.toLowerCase()));
    const unknown = [...new Set((scene_references ?? []).flat().filter((n) => !known.has(n.toLowerCase())))];
    if (unknown.length) throw new Error(`scene_references names ${unknown.map((n) => `"${n}"`).join(", ")}, which is not in references.`);
    for (const r of references ?? []) {
      if (!r.image.startsWith("asset:") && !existsSync(r.image)) throw new Error(`Reference image not found: ${r.image}`);
    }
    const job = this.queue.add({
      agent_refs: references?.length ? references : undefined,
      agent_scene_refs: references?.length ? scene_references : undefined,
      prompt: `Agent batch: ${scenes.length} images`,
      type: "image",
      max_credits: 0,
      aspect_ratio,
      download_quality,
      agent_scenes: scenes,
      output_dir,
      file_stem: this.nextStem(output_dir, "scene"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  async edit({ project, asset, prompt, download_quality }: Args<"edit">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({ prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, output_dir, file_stem: this.nextStem(output_dir, "edit") });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Flow's composer takes a start frame OR a character, never both; agent mode takes both, so this goes that way.
  async continue_shot({ project, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force }: Args<"continue_shot">) {
    // A lost queue entry is not proof that nothing ran: when the owner process is replaced mid-job the job vanishes
    // while Flow carries on and charges for it. Re-running then spends twice, which is exactly what happened on
    // 2026-09-20. Flow's own grid is the only honest record, so ask it before starting another paid generation.
    if (!force) {
      const recent = (await listAssets()).slice(0, 6).filter((a) => a.kind === "video");
      const source = from_asset.toLowerCase();
      const echo = recent.find((a) => {
        const n = a.name.toLowerCase();
        return n !== source && !n.startsWith(source) && words(n).some((w) => words(source).includes(w));
      });
      if (echo) {
        throw new Error(
          `Flow already holds a recent clip called "${echo.name}", which looks like a continuation of "${from_asset}" that may have just been generated and charged for. ` +
            `Check it with flow_assets / flow_download before spending again. Pass force: true if you really do want another take.`,
        );
      }
    }
    const output_dir = projectDir(project);
    const job = this.queue.add({
      prompt,
      type: "video",
      max_credits: 0,
      continue_from: from_asset,
      attach,
      continue_mode: mode,
      aspect_ratio,
      download_quality,
      output_dir,
      file_stem: this.nextStem(output_dir, "shot"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Moves a file or a project folder from the films folder to the system's bin - recoverable from there, never
  // erased. Anything outside the films folder is refused, so a bad path can never reach the rest of the Mac.
  async discard({ path }: Args<"discard">) {
    const target = resolve(path);
    // relative() works with either separator; a path that climbs out ("..") or lands on another drive is refused.
    const rel = relative(OUTPUT_ROOT, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only things inside your films folder can be moved to the bin from here.");
    if (!existsSync(target)) throw new Error("That file is already gone.");
    return { trashed: target, to: moveToBin(target), bin: BIN };
  }

  async trash({ name }: Args<"trash">) {
    if (this.queue.busy) throw new Error(BUSY);
    return trashAsset(name);
  }

  async character(a: Args<"character">) {
    if (this.queue.busy) throw new Error(BUSY);
    if (!a.image && !a.describe) throw new Error("Pass either `describe` (Flow draws the portrait) or `image`.");
    const made = await createCharacter(a);
    if (a.describe) rememberCharacter(a.name, a.describe);
    return { ...made, use_as: `asset:${a.name}` };
  }

  async character_edit({ name, change, look }: Args<"character_edit">) {
    if (this.queue.busy) throw new Error(BUSY);
    const out = await editCharacter(name, change);
    // Every scene that references the character quotes this description in its character lock, so it has to describe
    // the NEW look - "deep navy coat" left in it would argue with a portrait whose coat is now red.
    if (look) rememberCharacter(name, look);
    else if (change) rememberCharacter(name, `${characterLook(name) ?? ""} Changed since, and this wins over anything above: ${change.replace(/[.\s]+$/, "")}`.trim());
    return { ...out, use_as: `asset:${name}` };
  }

  async characters() {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listCharacters()).map((name) => ({ name, use_as: `asset:${name}` }));
  }

  // Panel only: deliberately NOT registered as an MCP tool, so a key typed into Flow Studio never reaches Claude.
  async set_key({ key }: Args<"set_key">) {
    return saveGeminiKey(key);
  }

  async voices() {
    // The panel words itself from these, so a PC never reads "this Mac".
    const place = { computer: COMPUTER, bin: BIN, local_engine: IS_MAC ? "macOS voice" : IS_WIN ? "Windows voice" : "System voice", platform: process.platform };
    return { gemini: GEMINI_VOICES, gemini_ready: Boolean(geminiKey()), mac: await localVoices(), place };
  }

  async narrate({ project, text, voice, engine, style }: Args<"narrate">) {
    const output_dir = projectDir(project);
    mkdirSync(output_dir, { recursive: true });
    const target = join(output_dir, `${this.nextStem(output_dir, "narration")}.m4a`);
    const spoken = engine === "mac" ? await speakLocally(text.trim(), voice, target) : await speakWithGemini(text.trim(), voice, target, style);
    return { output_dir, credits: 0, engine, voice, ...spoken };
  }

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }
}
