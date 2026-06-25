// Embedding inference runs here, off the API's main thread, so a batch embed
// can never freeze the event loop that serves /health and /search. Plain .mjs
// (no tsx needed in the worker) — all config arrives via workerData, so the
// worker imports nothing from the TS sources. Inference logic is a verbatim
// port of the former main-thread embedOneRaw, so vectors are unchanged.
import { parentPort, workerData } from "node:worker_threads";
import { pipeline, env } from "@huggingface/transformers";

const { model: modelId, dtype, dimensions, isQwen, queryPrefix, cacheDir } =
  workerData;
if (cacheDir) env.cacheDir = cacheDir;

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", modelId, { dtype });
  }
  return extractorPromise;
}

function normalize(vector) {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((v) => v / norm);
}

function toConfiguredDim(vector) {
  return vector.length > dimensions
    ? normalize(vector.slice(0, dimensions))
    : vector;
}

async function embedOneRaw(text) {
  const model = await getExtractor();
  if (isQwen) {
    const output = await model(text, { pooling: "none" });
    const dims = output.dims; // [1, seq, hidden] or [seq, hidden]
    const [seq, hidden] =
      dims.length === 3 ? [dims[1], dims[2]] : [dims[0], dims[1]];
    const data = output.data;
    const start = (seq - 1) * hidden; // last-token pooling
    return toConfiguredDim(
      normalize(Array.from(data.slice(start, start + hidden)))
    );
  }
  const output = await model(text, { pooling: "mean", normalize: true });
  return toConfiguredDim(Array.from(output.data));
}

// Warm the model at startup and announce readiness (error surfaces too).
getExtractor().then(
  () => parentPort.postMessage({ type: "ready" }),
  (err) => parentPort.postMessage({ type: "ready", error: String(err?.message ?? err) })
);

// Serialize jobs FIFO — one ONNX inference at a time (ORT already uses all
// cores internally; concurrent session.run is avoided).
let chain = Promise.resolve();
parentPort.on("message", (msg) => {
  const { id, texts, kind } = msg;
  chain = chain.then(async () => {
    try {
      const vectors = [];
      for (const t of texts) {
        const text = kind === "query" && isQwen ? queryPrefix + t : t;
        vectors.push(await embedOneRaw(text));
      }
      parentPort.postMessage({ id, vectors });
    } catch (err) {
      parentPort.postMessage({ id, error: String(err?.message ?? err) });
    }
  });
});
