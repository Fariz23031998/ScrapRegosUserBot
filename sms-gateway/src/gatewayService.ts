import {
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'auth_failed';

export type GatewayEvent =
  | {type: 'state'; state: ConnectionState}
  | {type: 'log'; message: string}
  | {type: 'job'; jobId: string; phone: string; orderId: string}
  | {type: 'result'; jobId: string; success: boolean; error?: string};

export type GatewayStatus = {
  running: boolean;
  state: ConnectionState;
};

const EVENT_NAME = 'GatewayEvent';

type GatewayServiceNative = {
  start: (
    serverUrl: string,
    token: string,
    subscriptionId: number,
  ) => Promise<void>;
  stop: () => Promise<void>;
  getStatus: () => Promise<GatewayStatus>;
  isIgnoringBatteryOptimizations: () => Promise<boolean>;
  requestIgnoreBatteryOptimizations: () => Promise<boolean>;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

function getGatewayServiceModule(): GatewayServiceNative | null {
  return (
    (NativeModules as {GatewayService?: GatewayServiceNative}).GatewayService ??
    null
  );
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) {
    return true;
  }

  const granted = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
  if (granted) {
    return true;
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    {
      title: 'Notification permission',
      message:
        'A persistent notification is required to keep the SMS gateway running in the background.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );

  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export async function startBackgroundService(
  serverUrl: string,
  token: string,
  subscriptionId: number,
): Promise<void> {
  const module = getGatewayServiceModule();
  if (!module) {
    return;
  }
  await module.start(serverUrl, token, subscriptionId);
}

export async function stopBackgroundService(): Promise<void> {
  const module = getGatewayServiceModule();
  if (!module) {
    return;
  }
  await module.stop();
}

export async function getGatewayStatus(): Promise<GatewayStatus> {
  const module = getGatewayServiceModule();
  if (!module) {
    return {running: false, state: 'disconnected'};
  }
  return module.getStatus();
}

export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  const module = getGatewayServiceModule();
  if (!module) {
    return true;
  }
  return module.isIgnoringBatteryOptimizations();
}

export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  const module = getGatewayServiceModule();
  if (!module) {
    return true;
  }
  return module.requestIgnoreBatteryOptimizations();
}

export function subscribeToGatewayEvents(
  handler: (event: GatewayEvent) => void,
): () => void {
  const module = getGatewayServiceModule();
  if (!module) {
    return () => {};
  }
  const emitter = new NativeEventEmitter(
    NativeModules.GatewayService as never,
  );
  const subscription = emitter.addListener(EVENT_NAME, (event: GatewayEvent) => {
    handler(event);
  });
  return () => subscription.remove();
}
