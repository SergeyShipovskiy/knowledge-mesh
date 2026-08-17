// Embedding inference runs here, in a CHILD PROCESS of the API, so a batch
// embed can never freeze the event loop that serves /health and /search — and
// so a wedged inference can be SIGKILLed without aborting the API (a
// worker_thread terminated inside onnxruntime takes the whole process down
// with SIGABRT, and its replacement thread cannot re-link the native addon).
// Plain .mjs, no tsx: config arrives as argv JSON, nothing is imported from
// the TS sources. Inference logic is unchanged, so vectors are unchanged.
import { pipeline, env } from "@huggingface/transformers";

const { model: modelId, dtype, dimensions, isQwen, queryPrefix, cacheDir } =
  JSON.parse(process.argv[2]);
if (cacheDir) env.cacheDir = cacheDir;

const send = (msg) => process.send?.(msg);

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
  () => send({ type: "ready" }),
  (err) => send({ type: "ready", error: String(err?.message ?? err) })
);

// Serialize jobs FIFO — one ONNX inference at a time (ORT already uses all
// cores internally). The parent's pool sends one job at a time anyway; this
// chain is the belt to that braces.
let chain = Promise.resolve();
process.on("message", (msg) => {
  const { id, texts, kind } = msg;
  chain = chain.then(async () => {
    try {
      const vectors = [];
      for (const t of texts) {
        const text = kind === "query" && isQwen ? queryPrefix + t : t;
        vectors.push(await embedOneRaw(text));
        // Per-text heartbeat: lets the parent tell "slow batch" from "wedged"
        // and keeps a 40-chunk note from tripping the stall watchdog.
        send({ type: "progress", id, done: vectors.length, total: texts.length });
      }
      send({ type: "result", id, vectors });
    } catch (err) {
      send({ type: "error", id, error: String(err?.message ?? err) });
    }
  });
});

// The parent is gone — never linger as an orphan holding the resident model.
process.on("disconnect", () => process.exit(0));
