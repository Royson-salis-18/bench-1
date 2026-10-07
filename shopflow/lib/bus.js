import { connect, StringCodec, AckPolicy, DeliverPolicy } from 'nats';
import { env, envInt } from './config.js';
import { log } from './log.js';

const sc = StringCodec();

export async function connectBus() {
  const nc = await connect({ servers: env('NATS_URL', 'nats://localhost:4222'), name: env('SERVICE_NAME', 'svc'), maxReconnectAttempts: -1 });
  return { nc, js: nc.jetstream(), jsm: await nc.jetstreamManager() };
}

export async function ensureStream(bus, name, subjects) {
  try { await bus.jsm.streams.info(name); }
  catch { await bus.jsm.streams.add({ name, subjects, max_age: 24 * 3600 * 1e9 }); }
}

export const publish = (bus, subject, payload) => bus.js.publish(subject, sc.encode(JSON.stringify(payload)));

/**
 * Durable pull consumer. Delivery semantics are all env-configurable because they are exactly
 * the settings that decide how a bad message behaves in production:
 *   <PFX>_MAX_DELIVER (-1 = redeliver forever), <PFX>_MAX_ACK_PENDING, <PFX>_ACK_WAIT_MS, <PFX>_NAK_DELAY_MS
 */
export async function consume(bus, { stream, durable, filter, prefix, handler }) {
  const cfg = {
    durable_name: durable,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    filter_subject: filter,
    max_deliver: envInt(`${prefix}_MAX_DELIVER`, 5),
    max_ack_pending: envInt(`${prefix}_MAX_ACK_PENDING`, 20),
    ack_wait: envInt(`${prefix}_ACK_WAIT_MS`, 30000) * 1e6,
  };
  try { await bus.jsm.consumers.add(stream, cfg); } catch (e) { if (!/already/i.test(e.message)) throw e; await bus.jsm.consumers.update(stream, durable, cfg); }
  const consumer = await bus.js.consumers.get(stream, durable);
  const nakDelay = envInt(`${prefix}_NAK_DELAY_MS`, 5000);
  const batch = Math.max(1, Math.min(cfg.max_ack_pending, 10));
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const msgs = await consumer.fetch({ max_messages: batch, expires: 2000 });
        for await (const m of msgs) {
          try {
            await handler(JSON.parse(sc.decode(m.data)), m);
            m.ack();
          } catch (e) {
            log.error('message handler failed', { subject: m.subject, delivery: m.info.deliveryCount, err: e.message });
            m.nak(nakDelay);
          }
        }
      } catch (e) {
        if (!stopped) { log.warn('consumer fetch failed', { err: e.message }); await new Promise((r) => setTimeout(r, 1000)); }
      }
    }
  })();
  return { stop: () => { stopped = true; } };
}

export async function streamLag(bus, stream, durable) {
  const ci = await bus.jsm.consumers.info(stream, durable);
  return { pending: ci.num_pending, ackPending: ci.num_ack_pending, redelivered: ci.num_redelivered };
}
