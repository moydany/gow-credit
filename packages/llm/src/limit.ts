/** Concurrency semaphore toward Anthropic: every call in a process goes through it, not just jobs. */
export function createLimiter(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency debe ser un entero >= 1')
  let active = 0
  const queue: (() => void)[] = []
  const next = () => {
    active -= 1
    queue.shift()?.()
  }
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve))
    active += 1
    try {
      return await task()
    } finally {
      next()
    }
  }
}
export type Limiter = ReturnType<typeof createLimiter>
