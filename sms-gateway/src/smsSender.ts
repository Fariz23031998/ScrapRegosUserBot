import {NativeModules, PermissionsAndroid, Platform} from 'react-native';

export type SimCard = {
  subscriptionId: number;
  slotIndex: number;
  displayName: string;
  carrierName: string;
  phoneNumber: string | null;
};

type SmsSendNative = {
  getSimCards: () => Promise<SimCard[]>;
  send: (phone: string, message: string, subscriptionId: number) => Promise<void>;
};

let selectedSubscriptionId: number | null = null;

function getSmsSendModule(): SmsSendNative {
  const module = (NativeModules as {SmsSend?: SmsSendNative}).SmsSend;
  if (!module?.send) {
    throw new Error(
      'SmsSend native module is not available — rebuild and reinstall the app',
    );
  }
  return module;
}

export function setSelectedSimSubscriptionId(subscriptionId: number | null): void {
  selectedSubscriptionId = subscriptionId;
}

export function getSelectedSimSubscriptionId(): number | null {
  return selectedSubscriptionId;
}

async function ensureSmsPermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new Error('SMS sending is only supported on Android');
  }

  const granted = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.SEND_SMS,
  );
  if (granted) {
    return;
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.SEND_SMS,
    {
      title: 'SMS Gateway permission',
      message: 'This app needs permission to send payment link SMS messages.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );

  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('SEND_SMS permission is not granted');
  }
}

async function ensurePhoneStatePermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  const granted = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
  );
  if (granted) {
    return;
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    {
      title: 'Phone state permission',
      message: 'This app needs access to detect available SIM cards.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );

  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('READ_PHONE_STATE permission is not granted');
  }
}

export async function getSimCards(): Promise<SimCard[]> {
  await ensurePhoneStatePermission();
  const module = getSmsSendModule();
  if (!module.getSimCards) {
    return [];
  }
  const cards = await module.getSimCards();
  return (cards ?? []).map(card => ({
    subscriptionId: card.subscriptionId,
    slotIndex: card.slotIndex,
    displayName: card.displayName,
    carrierName: card.carrierName,
    phoneNumber: card.phoneNumber || null,
  }));
}

export async function sendSms(phone: string, message: string): Promise<void> {
  await ensureSmsPermission();
  const subscriptionId = selectedSubscriptionId ?? -1;
  await getSmsSendModule().send(phone, message, subscriptionId);
}
