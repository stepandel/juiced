import assert from 'node:assert/strict';
import test from 'node:test';
import { jobWaker, type JobMessage } from '../src/queue';
import { jobHandler, jobRetry } from '../src/job-handler';
import type { services } from '../src/services';
import type { send } from '@vercel/queue';

test('a permanently failing worker cannot renew its wake-up chain past one minute', async () => {
  let time = 100_000;
  const sent: Array<{ message: JobMessage; options: Parameters<typeof send>[2] }> = [];
  const publish: typeof send = async (_topic, message, options) => {
    sent.push({ message: message as JobMessage, options });
    return { messageId: 'test' };
  };
  const wake = jobWaker(publish, () => time);
  const s = {} as ReturnType<typeof services>;
  let runs = 0;
  const handle = jobHandler(async () => s, async (_services, again = wake) => {
    runs++;
    await again(10);
  }, wake, () => time);
  await wake();
  const initialDeadline = sent[0]!.message.expiresAt;
  for (let index = 0; index < sent.length; index++) {
    const item = sent[index]!;
    time += (item.options?.delaySeconds ?? 0) * 1000;
    assert.equal(item.message.expiresAt, initialDeadline);
    assert.equal(item.options?.retentionSeconds, 60);
    await handle(item.message);
  }
  assert.equal(runs, 6);
  assert.equal(sent.length, 6, 'fresh queue messages cannot extend the chain');
  time = initialDeadline;
  await handle(sent[0]!.message);
  assert.equal(runs, 6, 'late redeliveries are acknowledged without running workers');
  await wake();
  assert.equal(sent.length, 7, 'the next cron can recover pending durable work');
});

test('concurrent wake-up sources use the same deduplication key for the same due slot', async () => {
  const keys: Array<string | undefined> = [];
  const publish: typeof send = async (_topic, _message, options) => {
    keys.push(options?.idempotencyKey);
    return { messageId: 'test' };
  };
  let time = 100_000;
  const wake = jobWaker(publish, () => time);
  await Promise.all([wake(), wake(), wake(1), wake(4)]);
  assert.equal(new Set(keys).size, 1);
  time += 5000;
  await wake();
  assert.notEqual(keys[4], keys[0]);
});

test('coalesced wake-ups wait until their callers have finished the shared time slot', async () => {
  const sent: Array<Parameters<typeof send>[2]> = [];
  const publish: typeof send = async (_topic, _message, options) => {
    sent.push(options);
    return { messageId: 'test' };
  };
  let time = 100_000;
  const wake = jobWaker(publish, () => time);
  await wake();
  time += 3000;
  await wake();
  assert.equal(sent[0]!.delaySeconds, 5);
  assert.equal(sent[1]!.delaySeconds, 2);
  assert.equal(sent[0]!.idempotencyKey, sent[1]!.idempotencyKey);
  time += 2000;
  await wake();
  assert.notEqual(sent[2]!.idempotencyKey, sent[0]!.idempotencyKey);
});

test('legacy, invalid and expired messages never initialize services', async () => {
  const handle = jobHandler(async () => { throw new Error('must not load'); }, undefined, undefined, () => 100_000);
  for (const message of [null, 'reconcile', {}, { type: 'reconcile' },
    { type: 'reconcile', expiresAt: 100_000 }, { type: 'reconcile', expiresAt: 160_001 },
    { type: 'reconcile', expiresAt: Infinity }, { type: 'wrong', expiresAt: 110_000 }]) {
    await handle(message);
  }
});

test('queue delivery failures back off and stop after three attempts', () => {
  type Metadata = Parameters<typeof jobRetry>[1];
  assert.deepEqual(jobRetry(new Error('database unavailable'), { deliveryCount: 1 } as Metadata), { afterSeconds: 5 });
  assert.deepEqual(jobRetry(new Error('database unavailable'), { deliveryCount: 2 } as Metadata), { afterSeconds: 10 });
  assert.deepEqual(jobRetry(new Error('database unavailable'), { deliveryCount: 3 } as Metadata), { acknowledge: true });
});
