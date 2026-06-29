import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {
  ConnectionState,
  GatewayEvent,
  SmsGatewayClient,
  SmsJob,
} from './src/wsClient';
import {
  getSimCards,
  setSelectedSimSubscriptionId,
  SimCard,
} from './src/smsSender';
import {
  requestNotificationPermission,
  startBackgroundService,
  stopBackgroundService,
  updateBackgroundServiceStatus,
} from './src/gatewayService';

const STORAGE_SERVER_URL = 'sms_gateway_server_url';
const STORAGE_TOKEN = 'sms_gateway_token';
const STORAGE_SIM_SUBSCRIPTION_ID = 'sms_gateway_sim_subscription_id';

async function requestSmsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }

  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.SEND_SMS,
    {
      title: 'SMS Gateway permission',
      message: 'This app needs permission to send payment link SMS messages.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );

  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

function notificationStatus(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected — listening for SMS jobs';
    case 'connecting':
      return 'Connecting to server…';
    case 'auth_failed':
      return 'Authentication failed';
    default:
      return 'Disconnected';
  }
}
function stateLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'auth_failed':
      return 'Auth failed';
    default:
      return 'Disconnected';
  }
}

function formatSimLabel(sim: SimCard): string {
  const parts = [sim.displayName];
  if (sim.carrierName) {
    parts.push(sim.carrierName);
  }
  if (sim.phoneNumber) {
    parts.push(sim.phoneNumber);
  }
  return parts.join(' · ');
}

function App() {
  const clientRef = useRef(new SmsGatewayClient());
  const [serverUrl, setServerUrl] = useState('ws://10.0.2.2:3000/sms-gateway/ws');
  const [token, setToken] = useState('');
  const [simCards, setSimCards] = useState<SimCard[]>([]);
  const [selectedSimId, setSelectedSimId] = useState<number | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected');
  const [running, setRunning] = useState(false);
  const [lastJob, setLastJob] = useState<SmsJob | null>(null);
  const [lastResult, setLastResult] = useState<string>('—');
  const [logs, setLogs] = useState<string[]>([]);

  const appendLog = useCallback((message: string) => {
    const line = `${new Date().toLocaleTimeString()} — ${message}`;
    setLogs(prev => [line, ...prev].slice(0, 50));
  }, []);

  const handleEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type === 'state') {
        setConnectionState(event.state);
        appendLog(`State: ${stateLabel(event.state)}`);
        updateBackgroundServiceStatus(notificationStatus(event.state)).catch(
          () => {},
        );
      } else if (event.type === 'job') {
        setLastJob(event.job);
        appendLog(`Job ${event.job.id} → ${event.job.phone}`);
        updateBackgroundServiceStatus(
          `Sending SMS to ${event.job.phone}`,
        ).catch(() => {});
      } else if (event.type === 'result') {
        const summary = event.success
          ? `Sent job ${event.jobId}`
          : `Failed job ${event.jobId}: ${event.error ?? 'unknown error'}`;
        setLastResult(summary);
        appendLog(summary);
        updateBackgroundServiceStatus(
          event.success
            ? 'Connected — listening for SMS jobs'
            : `Last send failed: ${event.error ?? 'unknown error'}`,
        ).catch(() => {});
      } else if (event.type === 'log') {
        appendLog(event.message);
      }
    },
    [appendLog],
  );

  useEffect(() => {
    AsyncStorage.getMany([
      STORAGE_SERVER_URL,
      STORAGE_TOKEN,
      STORAGE_SIM_SUBSCRIPTION_ID,
    ]).then(values => {
      const savedUrl = values[STORAGE_SERVER_URL];
      const savedToken = values[STORAGE_TOKEN];
      const savedSimId = values[STORAGE_SIM_SUBSCRIPTION_ID];
      if (savedUrl) {
        setServerUrl(savedUrl);
      }
      if (savedToken) {
        setToken(savedToken);
      }
      if (savedSimId) {
        const parsed = Number(savedSimId);
        if (Number.isFinite(parsed)) {
          setSelectedSimId(parsed);
          setSelectedSimSubscriptionId(parsed);
        }
      }
    });
  }, []);

  useEffect(() => {
    getSimCards()
      .then(cards => {
        setSimCards(cards);
        if (cards.length === 1) {
          setSelectedSimId(cards[0].subscriptionId);
          setSelectedSimSubscriptionId(cards[0].subscriptionId);
          AsyncStorage.setItem(
            STORAGE_SIM_SUBSCRIPTION_ID,
            String(cards[0].subscriptionId),
          ).catch(() => {});
          return;
        }

        if (cards.length > 1) {
          setSelectedSimId(current => {
            if (
              current != null &&
              cards.some(card => card.subscriptionId === current)
            ) {
              setSelectedSimSubscriptionId(current);
              return current;
            }
            setSelectedSimSubscriptionId(null);
            return null;
          });
        }
      })
      .catch(err => {
        appendLog(
          err instanceof Error ? err.message : 'Failed to load SIM cards',
        );
      });
  }, [appendLog]);

  const statusColor = useMemo(() => {
    if (connectionState === 'connected') {
      return '#1b8a4b';
    }
    if (connectionState === 'auth_failed') {
      return '#b42318';
    }
    if (connectionState === 'connecting') {
      return '#b7791f';
    }
    return '#667085';
  }, [connectionState]);

  const selectSim = async (subscriptionId: number) => {
    setSelectedSimId(subscriptionId);
    setSelectedSimSubscriptionId(subscriptionId);
    await AsyncStorage.setItem(
      STORAGE_SIM_SUBSCRIPTION_ID,
      String(subscriptionId),
    );
  };

  const startGateway = async () => {
    const trimmedUrl = serverUrl.trim();
    const trimmedToken = token.trim();
    if (!trimmedUrl || !trimmedToken) {
      Alert.alert('Missing settings', 'Enter server URL and gateway token.');
      return;
    }

    if (simCards.length > 1 && selectedSimId == null) {
      Alert.alert('Select SIM', 'Choose a SIM card before connecting.');
      return;
    }

    const allowed = await requestSmsPermission();
    if (!allowed) {
      Alert.alert('Permission required', 'Send SMS permission is required.');
      return;
    }

    const notificationsAllowed = await requestNotificationPermission();
    if (!notificationsAllowed) {
      Alert.alert(
        'Notification permission',
        'Background operation works best with notifications enabled. You can allow this in app settings.',
      );
    }

    await AsyncStorage.setMany({
      [STORAGE_SERVER_URL]: trimmedUrl,
      [STORAGE_TOKEN]: trimmedToken,
    });

    setRunning(true);
    await startBackgroundService('Connecting to server…');
    clientRef.current.start({
      serverUrl: trimmedUrl,
      token: trimmedToken,
      onEvent: handleEvent,
    });
  };

  const stopGateway = async () => {
    setRunning(false);
    clientRef.current.stop();
    await stopBackgroundService();
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.container}>
          <Text style={styles.title}>SMS Gateway</Text>
          <Text style={styles.subtitle}>
            Connects to backend WebSocket and sends queued payment SMS. Keeps
            running in the background while connected.
          </Text>

          <View style={styles.card}>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!running}
              placeholder="wss://aserver.tech/sms-gateway/ws"
              style={styles.input}
            />

            <Text style={styles.label}>Gateway token</Text>
            <TextInput
              value={token}
              onChangeText={setToken}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!running}
              secureTextEntry
              placeholder="SMS_GATEWAY_TOKEN"
              style={styles.input}
            />

            {simCards.length > 1 ? (
              <View style={styles.simSection}>
                <Text style={styles.label}>SIM card</Text>
                {simCards.map(sim => {
                  const selected = selectedSimId === sim.subscriptionId;
                  return (
                    <Pressable
                      key={sim.subscriptionId}
                      disabled={running}
                      onPress={() => selectSim(sim.subscriptionId)}
                      style={[
                        styles.simOption,
                        selected && styles.simOptionSelected,
                        running && styles.simOptionDisabled,
                      ]}>
                      <Text
                        style={[
                          styles.simOptionTitle,
                          selected && styles.simOptionTitleSelected,
                        ]}>
                        {formatSimLabel(sim)}
                      </Text>
                      <Text style={styles.simOptionMeta}>
                        Slot {sim.slotIndex + 1}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            <View style={styles.actions}>
              {!running ? (
                <Pressable style={styles.primaryButton} onPress={startGateway}>
                  <Text style={styles.primaryButtonText}>Connect</Text>
                </Pressable>
              ) : (
                <Pressable style={styles.secondaryButton} onPress={stopGateway}>
                  <Text style={styles.secondaryButtonText}>Disconnect</Text>
                </Pressable>
              )}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Status</Text>
            <Text style={[styles.status, {color: statusColor}]}>
              {stateLabel(connectionState)}
            </Text>
            <Text style={styles.meta}>
              SIM:{' '}
              {simCards.length === 0
                ? '—'
                : selectedSimId != null
                  ? formatSimLabel(
                      simCards.find(
                        sim => sim.subscriptionId === selectedSimId,
                      ) ?? simCards[0],
                    )
                  : simCards.length === 1
                    ? formatSimLabel(simCards[0])
                    : 'Not selected'}
            </Text>
            <Text style={styles.meta}>
              Last job: {lastJob ? `${lastJob.orderId} → ${lastJob.phone}` : '—'}
            </Text>
            <Text style={styles.meta}>Last result: {lastResult}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Activity</Text>
            {logs.length === 0 ? (
              <Text style={styles.meta}>No activity yet.</Text>
            ) : (
              logs.map(line => (
                <Text key={line} style={styles.logLine}>
                  {line}
                </Text>
              ))
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f4f6f8',
  },
  container: {
    padding: 20,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#101828',
  },
  subtitle: {
    fontSize: 15,
    color: '#475467',
    marginBottom: 4,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: '#eaecf0',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#344054',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d0d5dd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#101828',
    backgroundColor: '#ffffff',
  },
  simSection: {
    gap: 8,
  },
  simOption: {
    borderWidth: 1,
    borderColor: '#d0d5dd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
  },
  simOptionSelected: {
    borderColor: '#175cd3',
    backgroundColor: '#eff4ff',
  },
  simOptionDisabled: {
    opacity: 0.6,
  },
  simOptionTitle: {
    fontSize: 15,
    color: '#101828',
    fontWeight: '500',
  },
  simOptionTitleSelected: {
    color: '#175cd3',
  },
  simOptionMeta: {
    fontSize: 12,
    color: '#667085',
    marginTop: 2,
  },
  actions: {
    marginTop: 4,
  },
  primaryButton: {
    backgroundColor: '#175cd3',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 16,
  },
  secondaryButton: {
    backgroundColor: '#fef3f2',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#fecdca',
  },
  secondaryButtonText: {
    color: '#b42318',
    fontWeight: '600',
    fontSize: 16,
  },
  status: {
    fontSize: 18,
    fontWeight: '700',
  },
  meta: {
    fontSize: 14,
    color: '#475467',
  },
  logLine: {
    fontSize: 13,
    color: '#667085',
    marginBottom: 4,
  },
});

export default App;
