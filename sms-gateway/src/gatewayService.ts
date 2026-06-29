import {NativeModules, PermissionsAndroid, Platform} from 'react-native';

type GatewayServiceNative = {
  start: (status: string) => Promise<void>;
  updateStatus: (status: string) => Promise<void>;
  stop: () => Promise<void>;
};

function getGatewayServiceModule(): GatewayServiceNative | null {
  return (NativeModules as {GatewayService?: GatewayServiceNative}).GatewayService ?? null;
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

export async function startBackgroundService(status: string): Promise<void> {
  const module = getGatewayServiceModule();
  if (!module) {
    return;
  }
  await module.start(status);
}

export async function updateBackgroundServiceStatus(status: string): Promise<void> {
  const module = getGatewayServiceModule();
  if (!module) {
    return;
  }
  await module.updateStatus(status);
}

export async function stopBackgroundService(): Promise<void> {
  const module = getGatewayServiceModule();
  if (!module) {
    return;
  }
  await module.stop();
}
