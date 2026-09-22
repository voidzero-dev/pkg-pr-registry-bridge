type Stage = { name: string; startedAt: number; durationMs?: number; failed?: boolean }

/** Per-request diagnostics. Pending stages remain visible when the deadline wins. */
export class RequestTiming {
  readonly requestId = crypto.randomUUID()
  private readonly startedAt = Date.now()
  private readonly stages: Stage[] = []
  readonly cache: Record<string, 'hit' | 'miss' | 'bypass'> = {}
  refs = 0
  fallbackReads = 0

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const stage: Stage = { name, startedAt: Date.now() }
    this.stages.push(stage)
    try {
      return await operation()
    } catch (err) {
      stage.failed = true
      throw err
    } finally {
      stage.durationMs = Date.now() - stage.startedAt
    }
  }

  log(name: string, status: number): void {
    const now = Date.now()
    const durationMs = now - this.startedAt
    const message = JSON.stringify({
      event: 'packument',
      requestId: this.requestId,
      package: name,
      status,
      durationMs,
      cache: this.cache,
      refs: this.refs,
      fallbackReads: this.fallbackReads,
      stages: this.stages.map((stage) => ({
        name: stage.name,
        durationMs: stage.durationMs ?? now - stage.startedAt,
        pending: stage.durationMs === undefined,
        failed: stage.failed ?? false,
      })),
    })
    if (status >= 400 || durationMs >= 1000) console.warn(message)
    else console.log(message)
  }
}

export interface RequestWork {
  executionCtx: Pick<ExecutionContext, 'waitUntil'>
  timing: RequestTiming
  signal: AbortSignal
}
