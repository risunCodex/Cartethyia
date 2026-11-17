// Shared drain sequence for the process's queued writers. The console's manual
// "flush now" and the shutdown coordinator's telemetry flush must drain exactly
// the same buffers in the same order — a fourth writer added to one path but
// not the other would silently stop reaching the disk on one of them.
//
// The deps are the minimal write surface each buffer exposes: a `flush()` that
// resolves when the buffer is drained. The concrete buffers satisfy it, and a
// test can substitute stubs without casting.

/** Drains every buffered writer, in the canonical order. */
export async function flushAllBuffers(deps: {
  readonly telemetryBuffer: { flush(): Promise<void> };
  readonly usageFlush: { flush(): Promise<void> };
  readonly healthEventFlush: { flush(): Promise<void> };
}): Promise<void> {
  await deps.telemetryBuffer.flush();
  await deps.usageFlush.flush();
  await deps.healthEventFlush.flush();
}
