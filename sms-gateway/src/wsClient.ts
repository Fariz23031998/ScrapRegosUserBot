import {sendSms} from './smsSender';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'auth_failed';

export type SmsJob = {
  id: string;
  phone: string;
  message: string;
  orderId: string;
};

export type GatewayEvent =
  | {type: 'state'; state: ConnectionState}
  | {type: 'job'; job: SmsJob}
  | {type: 'result'; jobId: string; success: boolean; error?: string}
  | {type: 'log'; message: string};

type GatewayOptions = {
  serverUrl: string;
  token: string;
  onEvent: (event: GatewayEvent) => void;
};

const MAX_BACKOFF_MS = 30000;

function parseMessage(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class SmsGatewayClient {
  private ws: WebSocket | null = null;
  private shouldRun = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private options: GatewayOptions | null = null;

  start(options: GatewayOptions) {
    this.options = options;
    this.shouldRun = true;
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.emitState('disconnected');
  }

  private emitState(state: ConnectionState) {
    this.options?.onEvent({type: 'state', state});
  }

  private emitLog(message: string) {
    this.options?.onEvent({type: 'log', message});
  }

  private clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (!this.shouldRun) {
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private connect() {
    if (!this.options || !this.shouldRun) {
      return;
    }

    this.clearTimers();
    this.emitState('connecting');

    const ws = new WebSocket(this.options.serverUrl);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({type: 'auth', token: this.options?.token ?? ''}));
    };

    ws.onmessage = async event => {
      const msg = parseMessage(String(event.data));
      if (!msg || typeof msg.type !== 'string') {
        return;
      }

      if (msg.type === 'auth_ok') {
        this.reconnectAttempt = 0;
        this.emitState('connected');
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({type: 'ping'}));
          }
        }, 30000);
        return;
      }

      if (msg.type === 'auth_failed') {
        this.emitState('auth_failed');
        this.shouldRun = false;
        ws.close();
        return;
      }

      if (msg.type === 'sms' && msg.job && typeof msg.job === 'object') {
        const job = msg.job as SmsJob;
        this.options?.onEvent({type: 'job', job});
        try {
          await sendSms(job.phone, job.message);
          ws.send(
            JSON.stringify({type: 'result', jobId: job.id, success: true}),
          );
          this.options?.onEvent({type: 'result', jobId: job.id, success: true});
        } catch (err) {
          const error =
            err instanceof Error ? err.message : 'Failed to send SMS';
          ws.send(
            JSON.stringify({
              type: 'result',
              jobId: job.id,
              success: false,
              error,
            }),
          );
          this.options?.onEvent({
            type: 'result',
            jobId: job.id,
            success: false,
            error,
          });
        }
      }
    };

    ws.onerror = () => {
      this.emitLog('WebSocket error');
    };

    ws.onclose = () => {
      this.clearTimers();
      if (this.shouldRun) {
        this.emitState('disconnected');
        this.scheduleReconnect();
      }
    };
  }
}
