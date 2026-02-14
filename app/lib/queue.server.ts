/**
 * BullMQ queue definition — producer side.
 * Used by the Remix web process to enqueue diff jobs.
 *
 * We pass the Redis URL string directly to BullMQ instead of
 * creating our own IORedis instance, avoiding ioredis version conflicts.
 */
import { Queue } from "bullmq";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export interface DiffJobData {
  diffRunId: string;
}

let queue: Queue | undefined;

export function getDiffQueue(): Queue {
  if (!queue) {
    queue = new Queue("theme-diff", {
      connection: { url: REDIS_URL },
    });
  }
  return queue;
}

/** Enqueue a diff job for the given DiffRun id. */
export async function enqueueDiffJob(diffRunId: string): Promise<void> {
  const q = getDiffQueue();
  await q.add("diff", { diffRunId } satisfies DiffJobData, {
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}

/**
 * Remove any queued jobs for a given diffRunId.
 * Active jobs will self-cancel when they detect the DiffRun row is gone.
 * Returns true if a job was found (queued or active).
 */
export async function cancelDiffJob(diffRunId: string): Promise<boolean> {
  const q = getDiffQueue();
  let found = false;

  // Remove waiting/delayed jobs
  const waiting = await q.getJobs(["waiting", "delayed"]);
  for (const job of waiting) {
    if ((job.data as DiffJobData).diffRunId === diffRunId) {
      await job.remove();
      found = true;
    }
  }

  // Check if there's an active job — it will self-cancel when
  // it sees the DiffRun row has been deleted
  const active = await q.getJobs(["active"]);
  for (const job of active) {
    if ((job.data as DiffJobData).diffRunId === diffRunId) {
      found = true;
    }
  }

  return found;
}
