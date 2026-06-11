import { spawn } from "node:child_process";
import { ExtractionSchema, type Extraction, OBJECT_TYPES, SEMANTIC_RELATION_TYPES } from "./schema.js";

export const MODEL = process.env.EXTRACTOR_MODEL ?? "claude-opus-4-8";
const TIMEOUT_MS = 240_000;
const MAX_CONTENT_CHARS = 14_000;

export function buildPrompt(note: { path: string; title: string; content: string }): string {
  const content =
    note.content.length > MAX_CONTENT_CHARS
      ? `${note.content.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated]`
      : note.content;

  return `You are a knowledge-extraction engine for a personal knowledge graph shared by humans and AI agents.

Given one markdown note, extract the semantic knowledge objects it contains and the relations between them.

Object types: ${OBJECT_TYPES.join(", ")}.
Relation types: ${SEMANTIC_RELATION_TYPES.join(", ")}.

Rules:
- Extract only knowledge genuinely present in the note. Do not invent or pad.
- Prefer fewer, higher-value semantic objects (Decision/Idea/Claim/Problem/Constraint/Pattern) — typically 3-10 per note.
- STRUCTURAL objects are the exception to "fewer": if the note describes a software service, extract its architecture EXHAUSTIVELY — every Kafka topic it publishes to (Service PUBLISHES_TO Topic) and subscribes to (Service SUBSCRIBES_TO Topic), every other service it calls over HTTP (Service CALLS_HTTP Service), and its bounded context / domain area (Service BELONGS_TO BoundedContext). Downstream impact analysis depends on this list being complete — do not skip any.
- "name" must be short and canonical so it is reusable across notes: "Kafka", not "the Kafka cluster"; "Refund idempotency via state machine", not a full sentence. For Services use the bare service name exactly as written ("order-handler-service"); for Topics the exact topic string ("purchase.order.events"); for BoundedContexts the bare context name ("purchase").
- "summary" is 1-2 sentences in your own words, self-contained and useful without the note.
- "confidence" is 0-1: how clearly the note states this.
- Relations connect objects by their exact "name" from the objects array. You may also use the note's own title "${note.title}" as a source or target.
- Decisions/Patterns ADDRESS Problems; notes/components USE Technologies; Claims SUPPORT or CONTRADICT other objects; newer Decisions SUPERSEDE older ones.
- Do not use any tools.
- Output ONLY one JSON object, no markdown fences, no commentary, exactly this shape:
{"objects":[{"type":"Technology","name":"...","summary":"...","confidence":0.9}],"relations":[{"source":"...","target":"...","type":"USES","confidence":0.9}]}

NOTE PATH: ${note.path}
NOTE TITLE: ${note.title}

NOTE CONTENT:
${content}`;
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--model", MODEL], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          reject(new Error(`claude -p error result: ${String(envelope.result).slice(0, 500)}`));
          return;
        }
        resolve(String(envelope.result ?? ""));
      } catch {
        reject(new Error(`claude -p produced unparseable output: ${stdout.slice(0, 500)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseExtraction(text: string): Extraction {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`No JSON object in model output: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  return ExtractionSchema.parse(parsed);
}

export async function extract(note: {
  path: string;
  title: string;
  content: string;
}): Promise<Extraction> {
  const prompt = buildPrompt(note);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return parseExtraction(await runClaude(prompt));
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        console.warn(`  retry ${note.path}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
  }
  throw lastError;
}
