# Job Queue & Cancellation

**Producer:** `app/lib/queue.server.ts` (web process)
**Consumer:** `worker/index.ts` (worker process)
**Broker:** Redis via BullMQ

## Architecture

```
Web Process                    Redis                     Worker Process
───────────                    ─────                     ──────────────

User clicks                                              worker = new Worker(
"Run Diff"                                                 "theme-diff",
    │                                                      processDiffJob
    ▼                                                    )
enqueueDiffJob()                                              │
    │                                                         │
    ▼                                                         │
queue.add("diff",          ──►  Queue: "theme-diff"   ──►    │
  { diffRunId })                  job data stored             │
    │                             in Redis                    ▼
    │                                                    processDiffJob(job)
    ▼                                                    job.data.diffRunId
redirect to                                                   │
results page                                                  ▼
    │                                                    (4-phase pipeline)
    │                                                         │
    ▼                                                         ▼
poll DB every                                            Update DiffRun
2-3 seconds                                              status in DB
```

## Queue Configuration

### Producer (Web Process)

```typescript
// app/lib/queue.server.ts
const queue = new Queue("theme-diff", {
  connection: { url: REDIS_URL },
});

await queue.add("diff", { diffRunId }, {
  removeOnComplete: 100,  // keep last 100 completed jobs in Redis
  removeOnFail: 50,       // keep last 50 failed jobs in Redis
});
```

The queue singleton is lazily initialized and cached globally (avoids creating multiple Redis connections during hot reloads).

### Consumer (Worker Process)

```typescript
// worker/index.ts
const worker = new Worker("theme-diff", processDiffJob, {
  connection: { url: REDIS_URL },
  concurrency: 1,
  lockDuration: 600_000,  // 10 minutes
});
```

**Concurrency:** 1 — only processes one job at a time. Playwright browser instances are heavy, and running multiple simultaneously would consume too much memory.

**Lock duration:** 10 minutes. BullMQ uses a lock to prevent job duplication. If the worker doesn't extend the lock within this time, BullMQ considers the job stalled and may retry it. 10 minutes is generous because Playwright screenshots can take a while (especially with many page targets and slow stores).

## Job Lifecycle

```
1. WAITING    — Job is in the queue, waiting to be picked up
2. ACTIVE     — Worker is processing the job
3. COMPLETED  — Job finished successfully
4. FAILED     — Job threw an error
```

BullMQ manages these states automatically. The worker just processes the job function — BullMQ handles the state transitions based on whether the function returns or throws.

## Cancellation

Cancellation is the most nuanced part of the queue system.

### The Problem

BullMQ doesn't have a built-in "cancel active job" feature. Once `processDiffJob()` is running, there's no external signal to stop it. The function will keep executing until it returns or throws.

### The Solution: Cooperative Cancellation

When a user deletes a running diff:

**Step 1: Web process removes queued jobs and deletes the DB record**

```typescript
// app/lib/queue.server.ts
export async function cancelDiffJob(diffRunId: string): Promise<boolean> {
  const q = getDiffQueue();
  let found = false;

  // Remove jobs still waiting in the queue
  const waiting = await q.getJobs(["waiting", "delayed"]);
  for (const job of waiting) {
    if (job.data.diffRunId === diffRunId) {
      await job.remove();
      found = true;
    }
  }

  // Check if there's an active job (it will self-cancel)
  const active = await q.getJobs(["active"]);
  for (const job of active) {
    if (job.data.diffRunId === diffRunId) {
      found = true;
    }
  }

  return found;
}
```

Then the delete action removes the DiffRun from the database:
```typescript
await prisma.diffRun.delete({ where: { id: runId } });
```

**Step 2: Worker detects the deletion at checkpoints**

The worker periodically checks if the DiffRun still exists:

```typescript
// worker/index.ts
async function assertNotCancelled(diffRunId: string): Promise<void> {
  const run = await prisma.diffRun.findUnique({
    where: { id: diffRunId },
    select: { id: true },
  });
  if (!run) throw new JobCancelledError(diffRunId);
}
```

This is called at three points:
1. Every 10 assets during Phase 1 (asset comparison loop)
2. Between Phase 1 and Phase 2
3. Before each page target in Phase 3

**Step 3: Worker handles the cancellation gracefully**

```typescript
catch (err) {
  await closeBrowser();
  if (err instanceof JobCancelledError) {
    console.log(`[worker] Job cancelled: ${diffRunId}`);
    return;  // don't try to update the deleted row
  }
  // ... normal error handling
}
```

The `JobCancelledError` is caught specially — the worker logs the cancellation, closes the browser, and returns without trying to update the (now-deleted) DiffRun record.

### Cancellation Latency

Since cancellation is cooperative, there's a delay between the user clicking "Delete" and the worker actually stopping. The worst case:

- **Phase 1:** Up to 10 asset comparisons × 1.1 seconds each ≈ ~11 seconds
- **Phase 3:** Up to one full page target (2 screenshots + checks + diff) ≈ ~30-60 seconds

In practice, the worker usually notices within a few seconds.

### What About Files?

The delete action removes `public/runs/{id}/` before the worker might finish writing files. This is fine — if the worker writes to a deleted directory, the write fails, which becomes part of the error that's caught and handled.

## Event Handlers

```typescript
worker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("[worker] Worker error:", err.message);
});
```

These are BullMQ event handlers for logging. The `error` event fires for Redis connection issues and other worker-level problems.

## Graceful Shutdown

```typescript
async function shutdown() {
  console.log("[worker] Shutting down...");
  await closeBrowser();   // close Playwright
  await worker.close();   // disconnect from Redis
  await prisma.$disconnect(); // close DB connection
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

On Ctrl+C or system shutdown, the worker:
1. Closes the Playwright browser
2. Disconnects from Redis (BullMQ marks any active job as stalled)
3. Closes the Prisma connection
4. Exits cleanly

**What happens to active jobs?** If the worker shuts down mid-job, the job stays in "active" state until the lock expires (10 minutes). Then BullMQ will retry it when a worker comes back online.

## Redis Data

BullMQ stores all queue data in Redis under keys prefixed with `bull:theme-diff:`. You can inspect them:

```bash
# See all BullMQ keys
redis-cli KEYS "bull:theme-diff:*"

# See waiting jobs
redis-cli LRANGE "bull:theme-diff:wait" 0 -1

# See active jobs
redis-cli LRANGE "bull:theme-diff:active" 0 -1
```

But generally you won't need to — the DiffRun status in PostgreSQL is the source of truth for the UI.
