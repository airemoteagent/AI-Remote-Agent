// Serial task queue with cooperative cancellation and bounded backpressure.
// State is intentionally in-memory; persistence/checkpointing is a separate
// runtime concern and must not be implied by this primitive.

import { EventEmitter } from 'node:events';

export class TaskQueue extends EventEmitter {
  #queue = [];
  #running = false;
  #current = null;
  #jobs = new Map();
  #maxSize;

  constructor({ maxSize = 100 } = {}) {
    super();
    if (!Number.isInteger(maxSize) || maxSize < 1) throw new TypeError('maxSize must be a positive integer');
    this.#maxSize = maxSize;
  }

  /** Enqueue a job. Returns false instead of silently dropping on capacity. */
  enqueue(job) {
    if (!job || typeof job.run !== 'function' || typeof job.runId !== 'string' || !job.runId) {
      throw new TypeError('job requires runId and run()');
    }
    if (this.#jobs.has(job.runId)) return false;
    if (this.#queue.length + (this.#running ? 1 : 0) >= this.#maxSize) {
      this.emit('rejected', { runId: job.runId, reason: 'queue-capacity' });
      return false;
    }
    const controller = job.controller || new AbortController();
    const queuedJob = { ...job, controller, signal: controller.signal };
    this.#queue.push(queuedJob);
    this.#jobs.set(job.runId, queuedJob);
    const position = (this.#running ? 1 : 0) + this.#queue.length;
    this.emit('queued', { runId: job.runId, position });
    this.#drain();
    return this.#queue.length;
  }

  /** Cancel a queued job, or abort a running cooperative job. */
  cancel(runId, reason = 'cancelled') {
    const job = this.#jobs.get(runId);
    if (!job) return false;
    if (job === this.#current) {
      job.controller.abort(reason);
      return true;
    }
    const index = this.#queue.indexOf(job);
    if (index === -1) return false;
    this.#queue.splice(index, 1);
    this.#jobs.delete(runId);
    this.emit('cancelled', job, reason);
    return true;
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length) {
        const job = this.#queue.shift();
        this.#current = job;
        this.emit('start', job);
        let err;
        try {
          await job.run(job);
        } catch (error) {
          err = error;
          if (job.signal.aborted) this.emit('cancelled', job, job.signal.reason || 'cancelled');
          else this.emit('error', error, job);
        }
        this.#jobs.delete(job.runId);
        this.emit('done', job, err);
        this.#current = null;
      }
    } finally {
      this.#current = null;
      this.#running = false;
    }
  }

  /** Number of jobs waiting (not counting the one running). */
  get size() { return this.#queue.length; }
  /** True while a job is being executed. */
  get running() { return this.#running; }
  /** Maximum number of running + queued jobs. */
  get maxSize() { return this.#maxSize; }
}
