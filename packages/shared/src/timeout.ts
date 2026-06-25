/** Rejected when withTimeout fires. statusCode lets Fastify reply 504 directly. */
export class TimeoutError extends Error {
  readonly statusCode = 504;
  constructor(ms: number, label = "operation") {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Reject with TimeoutError if `promise` outlives `ms`. The underlying work may
 * keep running (a native ONNX call can't be aborted) — the point is to free the
 * request, not the CPU. ms <= 0 disables. The timer is unref'd so it never
 * keeps the process alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
