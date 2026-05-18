'use strict';

// #651 commit 10 (F9): unified scheduler for periodic UI tasks. Replaces
// the per-task setInterval calls in app.js with a single scheduler that
// coalesces wake-ups into a small set of discrete buckets (e.g., every
// 5s, 30s, 60s instead of N independent timers each firing on its own
// schedule).
//
// R10 budget instrumentation: stats() returns per-task fire count and
// elapsed time so the live perf test (PERF-LIVE-04) can assert the
// total UI wake-up budget stays under the milestone target.
//
// visibilitychange integration: when document.hidden becomes true, _tick
// skips firing — the browser already throttles setInterval in background
// tabs, but skipping is explicit so background tabs don't catch up with a
// burst of fires when becoming visible again.
//
// UMD wrapper at bottom: loaded via plain <script> in the browser and
// also requireable from Node tests.

(function (global) {

  function createTimers({
    bucketsMs = [5000, 10000, 30000, 60000],
    isVisible = () => (typeof document === 'undefined' || document.visibilityState !== 'hidden'),
    nowFn = () => Date.now(),
    setIntervalFn = (typeof setInterval !== 'undefined' ? setInterval : null),
    clearIntervalFn = (typeof clearInterval !== 'undefined' ? clearInterval : null),
    logger = { info() {}, warn() {}, debug() {} },
  } = {}) {
    if (!setIntervalFn || !clearIntervalFn) {
      throw new Error('timers: setInterval/clearInterval missing');
    }

    const tasks = new Map();        // id → { name, intervalMs, fn, lastFireAt, totalFires, totalMs }
    const taskBuckets = new Map();   // id → bucketMs
    const bucketTimers = new Map();  // bucketMs → timer handle
    let nextId = 1;

    function _findBucket(intervalMs) {
      // Pick the largest bucket <= intervalMs. If none, the smallest
      // bucket. This guarantees the task fires at least every intervalMs
      // (the bucket fires more often when intervalMs is not a multiple).
      let chosen = bucketsMs[0];
      for (const b of bucketsMs) {
        if (b <= intervalMs && b > chosen) chosen = b;
      }
      return chosen;
    }

    function _ensureBucketTimer(bucketMs) {
      if (bucketTimers.has(bucketMs)) return;
      const handle = setIntervalFn(() => _tick(bucketMs), bucketMs);
      bucketTimers.set(bucketMs, handle);
    }

    function _stopBucketIfEmpty(bucketMs) {
      for (const b of taskBuckets.values()) if (b === bucketMs) return;
      const handle = bucketTimers.get(bucketMs);
      if (handle) clearIntervalFn(handle);
      bucketTimers.delete(bucketMs);
    }

    function _tick(bucketMs) {
      if (!isVisible()) return; // skip when page hidden (R10: don't burn cycles)
      const now = nowFn();
      for (const [id, task] of tasks) {
        if (taskBuckets.get(id) !== bucketMs) continue;
        if (now - task.lastFireAt >= task.intervalMs) {
          const start = nowFn();
          try { task.fn(); }
          catch (err) {
            logger.warn('timers: task threw', { name: task.name, err: err.message });
          }
          task.lastFireAt = start;
          task.totalFires += 1;
          task.totalMs += nowFn() - start;
        }
      }
    }

    function register(name, intervalMs, fn) {
      if (typeof fn !== 'function') throw new TypeError('register: fn must be a function');
      if (typeof intervalMs !== 'number' || intervalMs <= 0) {
        throw new TypeError('register: intervalMs must be positive');
      }
      const id = nextId++;
      const bucket = _findBucket(intervalMs);
      tasks.set(id, {
        name, intervalMs, fn,
        lastFireAt: nowFn() - intervalMs, // fire on first tick
        totalFires: 0, totalMs: 0,
      });
      taskBuckets.set(id, bucket);
      _ensureBucketTimer(bucket);
      return id;
    }

    function unregister(id) {
      if (!tasks.has(id)) return false;
      const bucket = taskBuckets.get(id);
      tasks.delete(id);
      taskBuckets.delete(id);
      _stopBucketIfEmpty(bucket);
      return true;
    }

    function fireNow(id) {
      const task = tasks.get(id);
      if (!task) return false;
      const start = nowFn();
      try { task.fn(); }
      catch (err) {
        logger.warn('timers: fireNow task threw', { name: task.name, err: err.message });
      }
      task.lastFireAt = start;
      task.totalFires += 1;
      task.totalMs += nowFn() - start;
      return true;
    }

    function stats() {
      const out = [];
      for (const [id, t] of tasks) {
        out.push({
          id, name: t.name, intervalMs: t.intervalMs, bucket: taskBuckets.get(id),
          totalFires: t.totalFires, totalMs: t.totalMs,
          avgMs: t.totalFires > 0 ? t.totalMs / t.totalFires : 0,
        });
      }
      return {
        tasks: out,
        buckets: Array.from(bucketTimers.keys()).sort((a, b) => a - b),
        visible: isVisible(),
      };
    }

    function stop() {
      for (const handle of bucketTimers.values()) clearIntervalFn(handle);
      bucketTimers.clear();
      tasks.clear();
      taskBuckets.clear();
    }

    return { register, unregister, fireNow, stats, stop };
  }

  const exports = { createTimers };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else global.Timers = exports;

})(typeof window !== 'undefined' ? window : globalThis);
