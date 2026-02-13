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
