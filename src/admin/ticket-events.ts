import type { Unchecked } from '../types/unchecked';
const DEFAULT_MAX_QUEUE_SIZE = 100;

class TicketEventHub {
  declare maxQueueSize: number;
  declare subscribers: Set<any>;

  constructor({ maxQueueSize = DEFAULT_MAX_QUEUE_SIZE }: Unchecked = {}) {
    this.maxQueueSize = maxQueueSize;
    this.subscribers = new Set();
  }

  subscribe(send?: any) {
    const subscriber = {
      send,
      queue: [],
      flushing: false,
      closed: false,
    };
    this.subscribers.add(subscriber);

    return () => {
      subscriber.closed = true;
      subscriber.queue.length = 0;
      this.subscribers.delete(subscriber);
    };
  }

  publish(event?: any) {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      if (subscriber.queue.length >= this.maxQueueSize) {
        console.warn('[ticket-events] Subscriber queue full; dropping event', event?.type);
        continue;
      }
      subscriber.queue.push(event);
      this.flush(subscriber);
    }
  }

  async flush(subscriber?: any) {
    if (subscriber.flushing || subscriber.closed) return;
    subscriber.flushing = true;
    try {
      while (!subscriber.closed && subscriber.queue.length) {
        const event = subscriber.queue.shift();
        await subscriber.send(event);
      }
    } catch (error: any) {
      console.warn('[ticket-events] Subscriber disconnected:', error.message);
      subscriber.closed = true;
      subscriber.queue.length = 0;
      this.subscribers.delete(subscriber);
    } finally {
      subscriber.flushing = false;
    }
  }

  subscriberCount() {
    return this.subscribers.size;
  }
}

const ticketEventHub = new TicketEventHub();

export { DEFAULT_MAX_QUEUE_SIZE, TicketEventHub, ticketEventHub };
