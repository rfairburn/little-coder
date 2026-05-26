import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseSkillFile } from "./frontmatter.ts";

// ── Package root resolution ─────────────────────────────────────────────
// Extension lives at .pi/extensions/skill-inject/, repo root is 3 levels up.
function pkgRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
}

function resolveSettingsPath(): string | undefined {
  if (process.env.LITTLE_CODER_SETTINGS_FILE) return process.env.LITTLE_CODER_SETTINGS_FILE;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "little-coder", "settings.json");
  if (process.env.HOME) return join(process.env.HOME, ".config", "little-coder", "settings.json");
  return undefined;
}

function loadSettings(): any {
  const path = resolveSettingsPath();
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function getUserSkillsConfig(opts: any): UserSkillsConfig | null {
  // 1. Check systemPromptOptions (pi may pass little_coder settings through)
  const lc = opts.littleCoder ?? {};
  const fromOpts = (lc as any).userSkills ?? (lc as any).user_skills;
  if (fromOpts && typeof fromOpts === "object" && fromOpts.enabled !== false) {
    return configFromRaw(fromOpts);
  }
  // 2. Read from bundled settings.json directly
  const settings = loadSettings();
  const raw = settings?.little_coder?.user_skills;
  if (raw && typeof raw === "object" && raw.enabled !== false) {
    return configFromRaw(raw);
  }
  return null;
}

function configFromRaw(raw: any): UserSkillsConfig {
  return {
    enabled: raw.enabled !== false,
    dir: typeof raw.dir === "string" ? raw.dir : "~/.config/little-coder/skills",
    tokenBudget: typeof raw.tokenBudget === "number" ? raw.tokenBudget
      : (typeof raw.token_budget === "number" ? raw.token_budget : 300),
    minScore: typeof raw.minScore === "number" ? raw.minScore
      : (typeof raw.min_score === "number" ? raw.min_score : 2.0),
  };
}

// ── Tool-skill registry ─────────────────────────────────────────────────
// Port of local/skill_augment.py. Loads skills/tools/*.md once, hooks
// `before_agent_start` to append a `## Tool Usage Guidance` block to the
// system prompt. Per-user-prompt selection using the whitepaper's 3-priority
// algorithm (error recovery > recency > intent). Budget-guarded, cached.

interface ToolSkill {
  targetTool: string;
  body: string;
  tokenCost: number;
}

interface UserSkill {
  name: string;
  body: string;
  tokenCost: number;
  keywords: string[];
}

interface UserSkillsConfig {
  enabled: boolean;
  dir: string;
  tokenBudget: number;
  minScore: number;
}

const skills = new Map<string, ToolSkill>();
const userSkills = new Map<string, UserSkill>();
const selectionCache = new Map<string, string>();
const userSkillSelectionCache = new Map<string, string>();
let loaded = false;
let userSkillsLoaded = false;
let userSkillsConfig: UserSkillsConfig | null = null;

// State tracked across the session so we have error-recovery + recency
// signals by the time the next `before_agent_start` fires.
const recentToolCalls: string[] = []; // most-recent-first, capped at 8
let lastFailedTool: string | null = null;

// ── Intent keywords → likely tools ──────────────────────────────────────
const INTENT_MAP: Record<string, string[]> = {
  read: ["Read"], show: ["Read"], view: ["Read"], cat: ["Read"],
  write: ["Write"], create: ["Write", "Bash"],
  implement: ["Write", "Read"], code: ["Write", "Read"],
  function: ["Write", "Edit"], class: ["Write", "Edit"],
  edit: ["Edit"], change: ["Edit"], modify: ["Edit"],
  fix: ["Edit"], update: ["Edit"], replace: ["Edit"],
  add: ["Edit", "Write"], refactor: ["Edit", "Read"],
  run: ["Bash"], execute: ["Bash"], install: ["Bash"],
  build: ["Bash"], test: ["Bash"],
  find: ["Glob", "Grep"], search: ["Grep"],
  grep: ["Grep"], glob: ["Glob"],
  fetch: ["WebFetch"], download: ["WebFetch"], url: ["WebFetch"],
  web: ["WebSearch"],
  // Research / browser / evidence
  research: ["BrowserNavigate", "BrowserExtract", "EvidenceAdd"],
  researching: ["BrowserNavigate", "BrowserExtract", "EvidenceAdd"],
  wikipedia: ["BrowserNavigate", "BrowserExtract", "EvidenceAdd"],
  article: ["BrowserNavigate", "BrowserExtract", "EvidenceAdd"],
  citation: ["EvidenceAdd", "BrowserExtract"],
  cite: ["EvidenceAdd"],
  source: ["EvidenceAdd", "BrowserExtract"],
  fact: ["EvidenceAdd"],
  factcheck: ["EvidenceAdd", "BrowserExtract"],
  question: ["EvidenceAdd", "BrowserExtract"],
  answer: ["EvidenceAdd", "EvidenceList"],
  navigate: ["BrowserNavigate"],
  browse: ["BrowserNavigate", "BrowserExtract"],
  page: ["BrowserExtract"],
  click: ["BrowserClick"],
  // Sub-coder delegation
  delegate: ["dispatch"], dispatch: ["dispatch"], subagent: ["dispatch"],
  investigate: ["dispatch"], parallel: ["dispatch"],
};

function skillsDir(): string {
  return join(pkgRoot(), "skills", "tools");
}

function loadSkills(): void {
  if (loaded) return;
  loaded = true;
  const dir = skillsDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const parsed = parseSkillFile(readFileSync(join(dir, file), "utf-8"));
    if (!parsed) continue;
    const target = parsed.frontmatter.target_tool;
    if (typeof target !== "string" || !target) continue;
    const cost = typeof parsed.frontmatter.token_cost === "number"
      ? parsed.frontmatter.token_cost
      : 150;
    skills.set(target, { targetTool: target, body: parsed.body, tokenCost: cost });
  }
}

function predictTools(userText: string): string[] {
  const words = new Set(userText.toLowerCase().split(/\s+/).filter(Boolean));
  const predicted: string[] = [];
  for (const [kw, toolNames] of Object.entries(INTENT_MAP)) {
    if (!words.has(kw)) continue;
    for (const tn of toolNames) if (!predicted.includes(tn)) predicted.push(tn);
  }
  return predicted;
}

function selectSkills(prompt: string, budget: number, allowed?: Set<string>): ToolSkill[] {
  const selected: ToolSkill[] = [];
  let used = 0;
  const tryAdd = (name: string): void => {
    const sk = skills.get(name);
    if (!sk || selected.includes(sk)) return;
    if (allowed && !allowed.has(name)) return;
    if (used + sk.tokenCost > budget) return;
    selected.push(sk);
    used += sk.tokenCost;
  };

  // 1. Error recovery — last failed tool
  if (lastFailedTool) tryAdd(lastFailedTool);

  // 2. Recency — last 2 tool calls
  for (const name of recentToolCalls.slice(0, 4)) {
    if (used >= budget) break;
    tryAdd(name);
  }

  // 3. Intent prediction on the user's current prompt
  if (used < budget) {
    for (const name of predictTools(prompt)) {
      if (used >= budget) break;
      tryAdd(name);
    }
  }

  return selected;
}

function buildBlock(selected: ToolSkill[]): string {
  let out = "\n\n## Tool Usage Guidance\n";
  for (const s of selected) out += `\n### ${s.targetTool}\n${s.body}\n`;
  return out;
}

// ── User-skill registry ─────────────────────────────────────────────────
// Loads user-defined skills from a configurable directory (default:
// ~/.config/little-coder/skills/). Each skill is a SKILL.md inside a
// subdirectory. Selection is keyword-based: the skill's frontmatter
// `keywords` array (or auto-extracted words from `description`) is scored
// against the user's prompt. Top-scoring skills within budget are injected
// as a `## User Skills` block.

function resolveUserSkillsDir(configDir: string): string {
  let dir = configDir;
  if (dir.startsWith("~/")) {
    dir = homedir() + dir.slice(1);
  }
  return resolve(dir);
}

function loadUserSkills(config: UserSkillsConfig): void {
  if (userSkillsLoaded) return;
  userSkillsLoaded = true;
  const dir = resolveUserSkillsDir(config.dir);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const subdir = join(dir, entry);
    try {
      if (!statSync(subdir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillFile = join(subdir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFile(readFileSync(skillFile, "utf-8"));
    if (!parsed) continue;
    const fm = parsed.frontmatter;
    const name = typeof fm.name === "string" ? fm.name : entry;
    if (!name) continue;
    const cost = typeof fm.token_cost === "number"
      ? fm.token_cost
      : 150;
    // Keywords: explicit frontmatter array, or auto-extracted from description
    let keywords: string[] = [];
    if (Array.isArray(fm.keywords)) {
      keywords = (fm.keywords as string[]).map((k) => k.toLowerCase());
    } else if (typeof fm.description === "string") {
      // Auto-extract: words >= 3 chars, minus common stop words
      const stopWords = new Set([
        "the", "and", "for", "are", "but", "not", "you", "all",
        "can", "had", "her", "was", "one", "our", "out", "has",
        "have", "been", "from", "this", "that", "with", "will",
        "each", "make", "like", "just", "over", "such", "than",
        "them", "very", "when", "come", "could", "into", "some",
        "time", "only", "its", "use", "may", "most", "way",
        "what", "also", "their", "there", "these", "two",
      ]);
      keywords = fm.description
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !stopWords.has(w));
    }
    userSkills.set(name, { name, body: parsed.body, tokenCost: cost, keywords });
  }
}

function scoreUserSkill(userText: string, skill: UserSkill): number {
  if (skill.keywords.length === 0) return 0;
  const textLower = userText.toLowerCase();
  const words = new Set(textLower.split(/\s+/).filter(Boolean));
  let score = 0;
  for (const kw of skill.keywords) {
    if (kw.includes(" ")) {
      // Multi-word phrase match
      if (textLower.includes(kw)) score += 2.0;
    } else {
      // Single word match
      if (words.has(kw)) score += 1.0;
    }
  }
  return score;
}

function selectUserSkills(
  prompt: string,
  budget: number,
  minScore: number,
): UserSkill[] {
  const scored: Array<{ score: number; skill: UserSkill }> = [];
  for (const skill of userSkills.values()) {
    const s = scoreUserSkill(prompt, skill);
    if (s >= minScore) scored.push({ score: s, skill });
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);

  const selected: UserSkill[] = [];
  let used = 0;
  for (const { skill } of scored) {
    if (used + skill.tokenCost > budget) continue;
    selected.push(skill);
    used += skill.tokenCost;
  }
  return selected;
}

function buildUserSkillsBlock(selected: UserSkill[]): string {
  if (selected.length === 0) return "";
  let out = "\n\n## User Skills\n";
  for (const s of selected) out += `\n### ${s.name}\n${s.body}\n`;
  return out;
}

// Keyword-triggered directive: when the user's prompt smells like a
// research / web-lookup task, prepend an explicit "browse-first, then
// edit-write" rule. Without it, qwen-class small models often skip
// straight to Edit/Write on free-form questions, never gathering evidence.
const RESEARCH_TRIGGERS = [
  /\bbrows(?:e|ing|er)\b/i,
  /\bonline\b/i,
  /\bresearch(?:ing)?\b/i,
  /\blook\s+up\b/i,
  /\blookup\b/i,
  /\bsearch\s+(?:the|for)\b/i,
  /\bweb\s*search\b/i,
  /\bwikipedia\b/i,
  /\bwebsite\b/i,
  /\bweb\s*page\b/i,
  /\bgoogle\b/i,
  /\bcite|citation\b/i,
  /\bfact[-\s]?check/i,
];

function looksLikeResearchTask(text: string): boolean {
  if (!text) return false;
  for (const re of RESEARCH_TRIGGERS) {
    if (re.test(text)) return true;
  }
  return false;
}

const RESEARCH_DIRECTIVE = [
  "",
  "## Research-first directive",
  "This task involves online research. Before producing a final answer:",
  "1. Use BrowserNavigate / BrowserExtract (or WebSearch for first hops) to gather facts.",
  "2. Save each citable fact via EvidenceAdd before relying on it.",
  "3. Only after evidence is in place should you consider any Edit/Write tool calls.",
  "Skipping the gather step (going straight to Edit/Write or guessing from memory) is wrong — restart with the browse step instead.",
  "",
].join("\n");

export default function (pi: ExtensionAPI) {
  // Track tool usage across the whole session so recency + error-recovery
  // state is available on the next before_agent_start.
  pi.on("tool_result", async (event) => {
    const name = (event as any).toolName || (event as any).name;
    if (typeof name === "string") {
      // prepend, keep deduplicated recency list capped
      const idx = recentToolCalls.indexOf(name);
      if (idx !== -1) recentToolCalls.splice(idx, 1);
      recentToolCalls.unshift(name);
      if (recentToolCalls.length > 8) recentToolCalls.length = 8;
    }
    const isError = (event as any).isError === true;
    lastFailedTool = isError && typeof name === "string" ? name : null;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    loadSkills();

    const opts: any = (event as any).systemPromptOptions ?? {};
    const lc = opts.littleCoder ?? {};
    const budget: number = lc.skillTokenBudget ?? 300;
    if (budget <= 0) return;

    // Load user skills config from settings.json (pkg root or .pi/).
    if (!userSkillsConfig) {
      userSkillsConfig = getUserSkillsConfig(opts);
      if (userSkillsConfig) loadUserSkills(userSkillsConfig);
    }

    // Allow-list source: prefer systemPromptOptions (set by tool-gating's
    // before_agent_start), but fall back to LITTLE_CODER_ALLOWED_TOOLS env
    // directly. Pi runs before_agent_start handlers in extension load order
    // (alphabetical), so skill-inject fires before tool-gating and
    // lc.allowedTools is undefined on the first turn unless we read env here.
    let allowedList: string[] | undefined = lc.allowedTools;
    if (!allowedList && process.env.LITTLE_CODER_ALLOWED_TOOLS) {
      allowedList = process.env.LITTLE_CODER_ALLOWED_TOOLS
        .split(",").map((s) => s.trim()).filter(Boolean);
    }
    const allowed = allowedList && allowedList.length > 0 ? new Set(allowedList) : undefined;

    // Knowledge-inject may publish required_tools on systemPromptOptions —
    // pre-add those before selecting so they win even when budget is tight.
    // Benchmark profiles can also publish requiredTools (e.g. GAIA -> Browser+Evidence).
    const preferred: string[] = Array.isArray(lc.requiredTools) ? lc.requiredTools : [];
    for (const t of preferred) {
      if (!recentToolCalls.includes(t)) recentToolCalls.unshift(t);
    }

    const selected = skills.size > 0
      ? selectSkills(event.prompt ?? "", budget, allowed)
      : [];
    const researchTask = looksLikeResearchTask(event.prompt ?? "");

    // Select user skills (separate budget from tool skills)
    const selectedUserSkills = userSkillsConfig && userSkills.size > 0
      ? selectUserSkills(
          event.prompt ?? "",
          userSkillsConfig.tokenBudget,
          userSkillsConfig.minScore,
        )
      : [];

    if (selected.length === 0 && selectedUserSkills.length === 0 && !researchTask) return;

    const skillBlock = selected.length > 0
      ? (() => {
          const key = selected.map((s) => s.targetTool).sort().join("|");
          let b = selectionCache.get(key);
          if (b === undefined) {
            b = buildBlock(selected);
            selectionCache.set(key, b);
          }
          return b;
        })()
      : "";

    const userSkillsBlock = selectedUserSkills.length > 0
      ? (() => {
          const key = selectedUserSkills.map((s) => s.name).sort().join("|");
          let b = userSkillSelectionCache.get(key);
          if (b === undefined) {
            b = buildUserSkillsBlock(selectedUserSkills);
            userSkillSelectionCache.set(key, b);
          }
          return b;
        })()
      : "";

    const directive = researchTask ? RESEARCH_DIRECTIVE : "";

    // Fire-and-forget notify so the benchmark harness can count per-turn
    // skill injections without having to reconstruct the system prompt.
    try {
      const parts: string[] = [];
      if (selected.length > 0) {
        parts.push(`+${selected.length} [${selected.map((s) => s.targetTool).join(",")}]`);
      }
      if (selectedUserSkills.length > 0) {
        parts.push(`+${selectedUserSkills.length}user [${selectedUserSkills.map((s) => s.name).join(",")}]`);
      }
      if (researchTask) parts.push("+research-directive");
      ctx.ui.notify(`skill-inject: ${parts.join(" ")}`, "info");
    } catch {
      // UI unavailable in some run modes — silent best-effort
    }

    // Order: [AGENTS.md] [tool skill cards] [user skills] [research directive].
    // The directive is the LAST block in the system prompt by design —
    // small models show strong recency bias and the per-task instruction
    // is exactly what we want freshest in their attention.
    return { systemPrompt: (event.systemPrompt ?? "") + skillBlock + userSkillsBlock + directive };
  });
}
