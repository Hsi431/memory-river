export interface MockClock {
  advance(ms: number): void;
  restore(): void;
}

export function installMockClock(initialNow: number): MockClock {
  const originalNow = Date.now;
  let now = initialNow;
  Date.now = () => now;

  return {
    advance(ms: number) {
      now += ms;
    },
    restore() {
      Date.now = originalNow;
    },
  };
}
