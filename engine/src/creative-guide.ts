import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export type CreativeStage = "ideas" | "plan" | "storyboard";
const STAGES: readonly CreativeStage[] = ["ideas", "plan", "storyboard"];
const SOURCE = "docs/Google Flow Prompt Fix Log.md";
const sourceFile = new URL("../../docs/Google%20Flow%20Prompt%20Fix%20Log.md", import.meta.url);
// Which guide sections each stage reads, and the Studio adaptations added to them. Both are the owner's private
// prompt text, kept with the guide outside the public repository.
const configFile = new URL("../../claude/creative-guide.json", import.meta.url);
type GuideConfig = { selections: Record<CreativeStage, string[]>; adaptations: string[] };
const config = (): GuideConfig => JSON.parse(readFileSync(configFile, "utf8"));

// A fresh clone may not have the owner's private guide files.
export const creativeGuideAvailable = () => existsSync(sourceFile) && existsSync(configFile);
function source() {
  if (!creativeGuideAvailable()) throw new Error(`Owner creative guide not found: add ${SOURCE} and claude/creative-guide.json to use guided Ideas, Plan and Storyboard steps.`);
  const text = readFileSync(sourceFile, "utf8").replace(/\r\n/g, "\n");
  return { text, revision: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}
export function creativeGuideInfo() {
  // Opening a plan must still work without the guide; reading the guide is what reports it missing.
  const revision = creativeGuideAvailable() ? source().revision : null;
  return { source: SOURCE, revision, tool: "studio_guide_read", instruction: "Read this owner's guide for ideas, plan or storyboard before proposing scenarios or writing prompts; also read project notes and references." };
}
export function readCreativeGuide(stage: CreativeStage) {
  if (!STAGES.includes(stage)) throw new Error("Choose ideas, plan or storyboard guidance.");
  const { text, revision } = source();
  const { selections, adaptations } = config();
  const headings = [...text.matchAll(/^(#{1,6}) (.+)$/gm)];
  const sections = selections[stage].map(title => {
    const index = headings.findIndex(h => h[2].trim() === title);
    if (index < 0) throw new Error(`Owner guide section missing: ${title}. Review the source guide before writing prompts.`);
    const heading = headings[index];
    const next = headings.slice(index + 1).find(h => h[1].length <= heading[1].length);
    return text.slice(heading.index, next?.index ?? text.length).trim();
  });
  return { source: SOURCE, revision, stage, text: sections.join("\n\n"), adaptations: [...adaptations] };
}
