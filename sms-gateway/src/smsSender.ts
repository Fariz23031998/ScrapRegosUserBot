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
};

function getSmsSendModule(): SmsSendNative {
  const module = (NativeModules as {SmsSend?: SmsSendNative}).SmsSend;
  if (!module?.getSimCards) {
    throw new Error(
      'SmsSend native module is not available — rebuild and reinstall the app',
    );
  }
  return module;
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
