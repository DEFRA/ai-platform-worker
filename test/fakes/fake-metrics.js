// A recording stand-in for the CDP metrics helper (`server.metrics`): the
// worker only ever sends counters, durations and gauges.

/**
 * @returns {{counter: import('vitest').Mock, millis: import('vitest').Mock, gauge: import('vitest').Mock}}
 */
export function createFakeMetrics() {
  return {
    counter: vi.fn().mockResolvedValue(),
    millis: vi.fn().mockResolvedValue(),
    gauge: vi.fn().mockResolvedValue()
  }
}
