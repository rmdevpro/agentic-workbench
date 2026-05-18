'use strict';

// TI-MK-01..08: #651 commit 10 (F9) — unified scheduler.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimers } = require('../../public/js/timers.js');

function makeFakeClock() {
  let nowMs = 0;
  const intervals = []; // { handle, fn, ms, lastFire }
  let nextHandle = 1;
  return {
    nowFn: () => nowMs,
    advance(ms) {
      const target = nowMs + ms;
      // Fire any intervals whose next fire time is <= target. Step in
      // increments of the smallest interval so callbacks see the right time.
      while (nowMs < target) {
        let nextFireAt = target;
        for (const it of intervals) {
          const due = it.lastFire + it.ms;
          if (due > nowMs && due < nextFireAt) nextFireAt = due;
        }
        nowMs = nextFireAt;
        for (const it of intervals) {
          if (nowMs - it.lastFire >= it.ms) {
            it.lastFire = nowMs;
            try { it.fn(); } catch (_e) {}
          }
        }
      }
    },
    setIntervalFn(fn, ms) {
      const handle = nextHandle++;
      intervals.push({ handle, fn, ms, lastFire: nowMs });
      return handle;
    },
    clearIntervalFn(handle) {
      const i = intervals.findIndex((x) => x.handle === handle);
      if (i >= 0) intervals.splice(i, 1);
    },
    activeIntervals: intervals,
  };
}

// ── TI-MK-01: register + tick fires at the correct cadence ────────────────────

test('TI-MK-01: register + advance triggers task fn at its interval', () => {
  const clock = makeFakeClock();
  const t = createTimers({
    bucketsMs: [1000],
    isVisible: () => true,
    nowFn: clock.nowFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  let fires = 0;
  t.register('hello', 1000, () => { fires++; });
  clock.advance(3500);
  assert.equal(fires, 3, 'fired three times within 3.5s at 1s cadence');
});

// ── TI-MK-02: coalesced bucket — 2 tasks at 5s share one timer ────────────────

test('TI-MK-02: two tasks with same interval share a single bucket timer', () => {
  const clock = makeFakeClock();
  const t = createTimers({
    bucketsMs: [5000],
    isVisible: () => true,
    nowFn: clock.nowFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  t.register('a', 5000, () => {});
  t.register('b', 5000, () => {});
  assert.equal(clock.activeIntervals.length, 1, 'one bucket timer for two same-interval tasks');
});

// ── TI-MK-03: hidden page → tasks do not fire ─────────────────────────────────

test('TI-MK-03: isVisible=false → ticks fire bucket but no tasks run', () => {
  const clock = makeFakeClock();
  let visible = false;
  const t = createTimers({
    bucketsMs: [1000],
    isVisible: () => visible,
    nowFn: clock.nowFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  let fires = 0;
  t.register('hidden-poll', 1000, () => { fires++; });
  clock.advance(3000);
  assert.equal(fires, 0, 'tasks skipped while page hidden');
  visible = true;
  clock.advance(1000);
  assert.equal(fires, 1, 'task resumes after page becomes visible');
});

// ── TI-MK-04: unregister stops the task and stops the bucket if empty ─────────

test('TI-MK-04: unregister removes the task; bucket stops when empty', () => {
  const clock = makeFakeClock();
  const t = createTimers({
    bucketsMs: [5000],
    isVisible: () => true,
    nowFn: clock.nowFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  let fires = 0;
  const id = t.register('once', 5000, () => { fires++; });
  clock.advance(5000);
  assert.equal(fires, 1);
  t.unregister(id);
  clock.advance(20000);
  assert.equal(fires, 1, 'task does not fire after unregister');
  assert.equal(clock.activeIntervals.length, 0, 'bucket timer cleared');
});

// ── TI-MK-05: fireNow runs the task once and updates stats ────────────────────

test('TI-MK-05: fireNow executes the task immediately', () => {
  const clock = makeFakeClock();
  const t = createTimers({
    bucketsMs: [60000],
    isVisible: () => true,
    nowFn: clock.nowFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  let fires = 0;
  const id = t.register('manual', 60000, () => { fires++; });
  t.fireNow(id);
  assert.equal(fires, 1);
  assert.equal(t.stats().tasks[0].totalFires, 1);
});

// ── TI-MK-06: throwing task does not crash the scheduler ──────────────────────

test('TI-MK-06: task fn throws — scheduler continues, logger.warn called', () => {
  const clock = makeFakeClock();
  let warned = 0;
  const t = createTimers({
    bucketsMs: [1000],
    isVisible: () => true,
    nowFn: clock.nowFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    logger: { warn: () => { warned++; }, info() {}, debug() {} },
  });
  t.register('thrower', 1000, () => { throw new Error('boom'); });
  let okFires = 0;
  t.register('ok', 1000, () => { okFires++; });
  clock.advance(3000);
  assert.equal(okFires, 3, 'other tasks keep firing');
  assert.equal(warned, 3, 'logger.warn called once per throw');
});

// ── TI-MK-07: bucket selection picks the largest bucket <= interval ───────────

test('TI-MK-07: register interval=30000 with buckets [5000,10000,30000,60000] → 30s bucket', () => {
  const clock = makeFakeClock();
  const t = createTimers({
    bucketsMs: [5000, 10000, 30000, 60000],
    isVisible: () => true,
    nowFn: clock.nowFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  t.register('thirty', 30000, () => {});
  assert.equal(t.stats().tasks[0].bucket, 30000);
});

// ── TI-MK-08: stats() includes per-task fires + bucket assignment ─────────────

test('TI-MK-08: stats reports per-task fires + bucket; stop clears everything', () => {
  const clock = makeFakeClock();
  const t = createTimers({
    bucketsMs: [1000, 5000],
    isVisible: () => true,
    nowFn: clock.nowFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  t.register('one', 1000, () => {});
  t.register('five', 5000, () => {});
  clock.advance(5000);
  const s = t.stats();
  assert.equal(s.tasks.length, 2);
  assert.equal(s.buckets.length, 2);
  t.stop();
  assert.equal(t.stats().tasks.length, 0);
  assert.equal(clock.activeIntervals.length, 0);
});
