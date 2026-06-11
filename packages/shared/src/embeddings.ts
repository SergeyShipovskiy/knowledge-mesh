import {
  pipeline,
  env as hfEnv,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { config } from "./config.js";

hfEnv.cacheDir = config.modelsDir;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

// Qwen3-Embedding is instruction-aware: queries carry an instruct prefix,
// documents are embedded as-is, and pooling is last-token (not mean).
const isQwen = /qwen/i.test(config.embedding.model);
const QWEN_QUERY_PREFIX =
  "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    // Cast: pipeline()'s overload union blows up TS inference (TS2590).
    const createPipeline = pipeline as (
      task: string,
      model: string,
      options?: Record<string, unknown>
    ) => Promise<FeatureExtractionPipeline>;
    extractor = createPipeline("feature-extraction", config.embedding.model, {
      dtype: config.embedding.dtype,
    });
  }
  return extractor;
}

function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((v) => v / norm);
}

/** Truncate to configured dimensions (Matryoshka) and re-normalize. */
function toConfiguredDim(vector: number[]): number[] {
  const dim = config.embedding.dimensions;
  return vector.length > dim ? normalize(vector.slice(0, dim)) : vector;
}

async function embedOneRaw(text: string): Promise<number[]> {
  const model = await getExtractor();

  if (isQwen) {
    const output = await model(text, { pooling: "none" });
    const dims = output.dims; // [1, seq, hidden] or [seq, hidden]
    const [seq, hidden] =
      dims.length === 3 ? [dims[1], dims[2]] : [dims[0], dims[1]];
    const data = output.data as Float32Array;
    const start = (seq - 1) * hidden; // last-token pooling
    return toConfiguredDim(
      normalize(Array.from(data.slice(start, start + hidden)))
    );
  }

  const output = await model(text, { pooling: "mean", normalize: true });
  return toConfiguredDim(Array.from(output.data as Float32Array));
}

let localOnly = false;

/** Called by the API process: it hosts the model and must never call itself. */
export function useLocalEmbeddings(): void {
  localOnly = true;
}

async function remoteEmbed(
  texts: string[],
  kind: "document" | "query"
): Promise<number[][]> {
  const url = `${config.embedding.remoteUrl}/embed`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, kind }),
      });
      if (!response.ok) throw new Error(`embed API ${response.status}`);
      const body = (await response.json()) as { vectors: number[][] };
      return body.vectors;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(
    `Remote embedding failed (is the Knowledge API running at ${config.embedding.remoteUrl}?): ${(lastError as Error).message}`
  );
}

function useRemote(): boolean {
  return !localOnly && Boolean(config.embedding.remoteUrl);
}

const REMOTE_BATCH = 100;

/** Embed documents/chunks (no instruction prefix). */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (useRemote()) {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += REMOTE_BATCH) {
      vectors.push(...(await remoteEmbed(texts.slice(i, i + REMOTE_BATCH), "document")));
    }
    return vectors;
  }
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedOneRaw(text));
  }
  return results;
}

/** Embed a single document/chunk. */
export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  return vector;
}

/** Embed a search query (instruction prefix on instruction-aware models). */
export async function embedQuery(query: string): Promise<number[]> {
  if (useRemote()) {
    const [vector] = await remoteEmbed([query], "query");
    return vector;
  }
  return embedOneRaw(isQwen ? QWEN_QUERY_PREFIX + query : query);
}
