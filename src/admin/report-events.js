const DEFAULT_MAX_QUEUE_SIZE = 100;

class ReportEventHub {
  constructor({ maxQueueSize = DEFAULT_MAX_QUEUE_SIZE } = {}) {
    this.maxQueueSize = maxQueueSize;
    this.subscribers = new Set();
  }

  subscribe(actorKey, send) {
    const subscriber = {
      actorKey,
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

  publish(actorKey, event) {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      if (subscriber.actorKey !== actorKey) continue;
      if (subscriber.queue.length >= this.maxQueueSize) {
        console.warn('[report-events] Subscriber queue full; dropping event', event?.type);
        continue;
      }
      subscriber.queue.push(event);
      this.flush(subscriber);
    }
  }

  async flush(subscriber) {
    if (subscriber.flushing || subscriber.closed) return;
    subscriber.flushing = true;
    try {
      while (!subscriber.closed && subscriber.queue.length) {
        const event = subscriber.queue.shift();
        await subscriber.send(event);
      }
    } catch (error) {
      console.warn('[report-events] Subscriber disconnected:', error.message);
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

const reportEventHub = new ReportEventHub();

module.exports = {
  DEFAULT_MAX_QUEUE_SIZE,
  ReportEventHub,
  reportEventHub,
};
