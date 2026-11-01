"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var async_storage_1 = require("@react-native-async-storage/async-storage");
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var smsSender_1 = require("./src/smsSender");
var gatewayService_1 = require("./src/gatewayService");
var STORAGE_SERVER_URL = 'sms_gateway_server_url';
var STORAGE_TOKEN = 'sms_gateway_token';
var STORAGE_SIM_SUBSCRIPTION_ID = 'sms_gateway_sim_subscription_id';
function requestSmsPermission() {
    return __awaiter(this, void 0, void 0, function () {
        var granted;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (react_native_1.Platform.OS !== 'android') {
                        return [2 /*return*/, false];
                    }
                    return [4 /*yield*/, react_native_1.PermissionsAndroid.request(react_native_1.PermissionsAndroid.PERMISSIONS.SEND_SMS, {
                            title: 'SMS Gateway permission',
                            message: 'This app needs permission to send payment link SMS messages.',
                            buttonPositive: 'Allow',
                            buttonNegative: 'Deny',
                        })];
                case 1:
                    granted = _a.sent();
                    return [2 /*return*/, granted === react_native_1.PermissionsAndroid.RESULTS.GRANTED];
            }
        });
    });
}
function stateLabel(state) {
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
function formatSimLabel(sim) {
    var parts = [sim.displayName];
    if (sim.carrierName) {
        parts.push(sim.carrierName);
    }
    if (sim.phoneNumber) {
        parts.push(sim.phoneNumber);
    }
    return parts.join(' · ');
}
function App() {
    var _this = this;
    var _a;
    var _b = (0, react_1.useState)('ws://10.0.2.2:3000/sms-gateway/ws'), serverUrl = _b[0], setServerUrl = _b[1];
    var _c = (0, react_1.useState)(''), token = _c[0], setToken = _c[1];
    var _d = (0, react_1.useState)([]), simCards = _d[0], setSimCards = _d[1];
    var _e = (0, react_1.useState)(null), selectedSimId = _e[0], setSelectedSimId = _e[1];
    var _f = (0, react_1.useState)('disconnected'), connectionState = _f[0], setConnectionState = _f[1];
    var _g = (0, react_1.useState)(false), running = _g[0], setRunning = _g[1];
    var _h = (0, react_1.useState)(null), lastJob = _h[0], setLastJob = _h[1];
    var _j = (0, react_1.useState)('—'), lastResult = _j[0], setLastResult = _j[1];
    var _k = (0, react_1.useState)([]), logs = _k[0], setLogs = _k[1];
    var _l = (0, react_1.useState)(true), batteryExempt = _l[0], setBatteryExempt = _l[1];
    var appendLog = (0, react_1.useCallback)(function (message) {
        var line = "".concat(new Date().toLocaleTimeString(), " \u2014 ").concat(message);
        setLogs(function (prev) { return __spreadArray([line], prev, true).slice(0, 50); });
    }, []);
    var handleEvent = (0, react_1.useCallback)(function (event) {
        var _a;
        if (event.type === 'state') {
            setConnectionState(event.state);
            appendLog("State: ".concat(stateLabel(event.state)));
        }
        else if (event.type === 'job') {
            setLastJob({
                jobId: event.jobId,
                phone: event.phone,
                orderId: event.orderId,
            });
            appendLog("Job ".concat(event.jobId, " \u2192 ").concat(event.phone));
        }
        else if (event.type === 'result') {
            var summary = event.success
                ? "Sent job ".concat(event.jobId)
                : "Failed job ".concat(event.jobId, ": ").concat((_a = event.error) !== null && _a !== void 0 ? _a : 'unknown error');
            setLastResult(summary);
            appendLog(summary);
        }
        else if (event.type === 'log') {
            appendLog(event.message);
        }
    }, [appendLog]);
    (0, react_1.useEffect)(function () {
        var unsubscribe = (0, gatewayService_1.subscribeToGatewayEvents)(handleEvent);
        (0, gatewayService_1.getGatewayStatus)()
            .then(function (status) {
            setRunning(status.running);
            setConnectionState(status.state);
        })
            .catch(function () { });
        (0, gatewayService_1.isIgnoringBatteryOptimizations)()
            .then(setBatteryExempt)
            .catch(function () { });
        return unsubscribe;
    }, [handleEvent]);
    (0, react_1.useEffect)(function () {
        async_storage_1.default.getMany([
            STORAGE_SERVER_URL,
            STORAGE_TOKEN,
            STORAGE_SIM_SUBSCRIPTION_ID,
        ]).then(function (values) {
            var savedUrl = values[STORAGE_SERVER_URL];
            var savedToken = values[STORAGE_TOKEN];
            var savedSimId = values[STORAGE_SIM_SUBSCRIPTION_ID];
            if (savedUrl) {
                setServerUrl(savedUrl);
            }
            if (savedToken) {
                setToken(savedToken);
            }
            if (savedSimId) {
                var parsed = Number(savedSimId);
                if (Number.isFinite(parsed)) {
                    setSelectedSimId(parsed);
                }
            }
        });
    }, []);
    (0, react_1.useEffect)(function () {
        (0, smsSender_1.getSimCards)()
            .then(function (cards) {
            setSimCards(cards);
            if (cards.length === 1) {
                setSelectedSimId(cards[0].subscriptionId);
                async_storage_1.default.setItem(STORAGE_SIM_SUBSCRIPTION_ID, String(cards[0].subscriptionId)).catch(function () { });
                return;
            }
            if (cards.length > 1) {
                setSelectedSimId(function (current) {
                    if (current != null &&
                        cards.some(function (card) { return card.subscriptionId === current; })) {
                        return current;
                    }
                    return null;
                });
            }
        })
            .catch(function (err) {
            appendLog(err instanceof Error ? err.message : 'Failed to load SIM cards');
        });
    }, [appendLog]);
    var statusColor = (0, react_1.useMemo)(function () {
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
    var selectSim = function (subscriptionId) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setSelectedSimId(subscriptionId);
                    return [4 /*yield*/, async_storage_1.default.setItem(STORAGE_SIM_SUBSCRIPTION_ID, String(subscriptionId))];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); };
    var enableBackground = function () { return __awaiter(_this, void 0, void 0, function () {
        var exempt;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, gatewayService_1.requestIgnoreBatteryOptimizations)()];
                case 1:
                    exempt = _a.sent();
                    setBatteryExempt(exempt);
                    return [2 /*return*/];
            }
        });
    }); };
    var startGateway = function () { return __awaiter(_this, void 0, void 0, function () {
        var trimmedUrl, trimmedToken, allowed, notificationsAllowed, exempt, subscriptionId;
        var _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    trimmedUrl = serverUrl.trim();
                    trimmedToken = token.trim();
                    if (!trimmedUrl || !trimmedToken) {
                        react_native_1.Alert.alert('Missing settings', 'Enter server URL and gateway token.');
                        return [2 /*return*/];
                    }
                    if (simCards.length > 1 && selectedSimId == null) {
                        react_native_1.Alert.alert('Select SIM', 'Choose a SIM card before connecting.');
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, requestSmsPermission()];
                case 1:
                    allowed = _d.sent();
                    if (!allowed) {
                        react_native_1.Alert.alert('Permission required', 'Send SMS permission is required.');
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, (0, gatewayService_1.requestNotificationPermission)()];
                case 2:
                    notificationsAllowed = _d.sent();
                    if (!notificationsAllowed) {
                        react_native_1.Alert.alert('Notification permission', 'Background operation works best with notifications enabled. You can allow this in app settings.');
                    }
                    return [4 /*yield*/, (0, gatewayService_1.isIgnoringBatteryOptimizations)()];
                case 3:
                    exempt = _d.sent();
                    setBatteryExempt(exempt);
                    if (!!exempt) return [3 /*break*/, 5];
                    return [4 /*yield*/, (0, gatewayService_1.requestIgnoreBatteryOptimizations)()];
                case 4:
                    _d.sent();
                    _d.label = 5;
                case 5: return [4 /*yield*/, async_storage_1.default.setMany((_a = {},
                        _a[STORAGE_SERVER_URL] = trimmedUrl,
                        _a[STORAGE_TOKEN] = trimmedToken,
                        _a))];
                case 6:
                    _d.sent();
                    subscriptionId = (_c = selectedSimId !== null && selectedSimId !== void 0 ? selectedSimId : (_b = simCards[0]) === null || _b === void 0 ? void 0 : _b.subscriptionId) !== null && _c !== void 0 ? _c : -1;
                    setRunning(true);
                    return [4 /*yield*/, (0, gatewayService_1.startBackgroundService)(trimmedUrl, trimmedToken, subscriptionId)];
                case 7:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); };
    var stopGateway = function () { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setRunning(false);
                    return [4 /*yield*/, (0, gatewayService_1.stopBackgroundService)()];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); };
    return (<react_native_safe_area_context_1.SafeAreaProvider>
      <react_native_safe_area_context_1.SafeAreaView style={styles.safeArea}>
        <react_native_1.StatusBar barStyle="dark-content"/>
        <react_native_1.ScrollView contentContainerStyle={styles.container}>
          <react_native_1.Text style={styles.title}>SMS Gateway</react_native_1.Text>
          <react_native_1.Text style={styles.subtitle}>
            Connects to backend WebSocket and sends queued payment SMS. Runs as a
            background service that survives app close and restarts on reboot.
          </react_native_1.Text>

          {!batteryExempt ? (<react_native_1.View style={styles.warningCard}>
              <react_native_1.Text style={styles.warningTitle}>Battery optimization is on</react_native_1.Text>
              <react_native_1.Text style={styles.warningText}>
                To keep the gateway alive when the app is closed, disable battery
                optimization for this app. On some phones you must also enable
                "Autostart" in system settings.
              </react_native_1.Text>
              <react_native_1.Pressable style={styles.warningButton} onPress={enableBackground}>
                <react_native_1.Text style={styles.warningButtonText}>
                  Allow background running
                </react_native_1.Text>
              </react_native_1.Pressable>
            </react_native_1.View>) : null}

          <react_native_1.View style={styles.card}>
            <react_native_1.Text style={styles.label}>Server URL</react_native_1.Text>
            <react_native_1.TextInput value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" autoCorrect={false} editable={!running} placeholder="wss://aserver.tech/sms-gateway/ws" style={styles.input}/>

            <react_native_1.Text style={styles.label}>Gateway token</react_native_1.Text>
            <react_native_1.TextInput value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} editable={!running} secureTextEntry placeholder="SMS_GATEWAY_TOKEN" style={styles.input}/>

            {simCards.length > 1 ? (<react_native_1.View style={styles.simSection}>
                <react_native_1.Text style={styles.label}>SIM card</react_native_1.Text>
                {simCards.map(function (sim) {
                var selected = selectedSimId === sim.subscriptionId;
                return (<react_native_1.Pressable key={sim.subscriptionId} disabled={running} onPress={function () { return selectSim(sim.subscriptionId); }} style={[
                        styles.simOption,
                        selected && styles.simOptionSelected,
                        running && styles.simOptionDisabled,
                    ]}>
                      <react_native_1.Text style={[
                        styles.simOptionTitle,
                        selected && styles.simOptionTitleSelected,
                    ]}>
                        {formatSimLabel(sim)}
                      </react_native_1.Text>
                      <react_native_1.Text style={styles.simOptionMeta}>
                        Slot {sim.slotIndex + 1}
                      </react_native_1.Text>
                    </react_native_1.Pressable>);
            })}
              </react_native_1.View>) : null}

            <react_native_1.View style={styles.actions}>
              {!running ? (<react_native_1.Pressable style={styles.primaryButton} onPress={startGateway}>
                  <react_native_1.Text style={styles.primaryButtonText}>Connect</react_native_1.Text>
                </react_native_1.Pressable>) : (<react_native_1.Pressable style={styles.secondaryButton} onPress={stopGateway}>
                  <react_native_1.Text style={styles.secondaryButtonText}>Disconnect</react_native_1.Text>
                </react_native_1.Pressable>)}
            </react_native_1.View>
          </react_native_1.View>

          <react_native_1.View style={styles.card}>
            <react_native_1.Text style={styles.label}>Status</react_native_1.Text>
            <react_native_1.Text style={[styles.status, { color: statusColor }]}>
              {stateLabel(connectionState)}
            </react_native_1.Text>
            <react_native_1.Text style={styles.meta}>
              SIM:{' '}
              {simCards.length === 0
            ? '—'
            : selectedSimId != null
                ? formatSimLabel((_a = simCards.find(function (sim) { return sim.subscriptionId === selectedSimId; })) !== null && _a !== void 0 ? _a : simCards[0])
                : simCards.length === 1
                    ? formatSimLabel(simCards[0])
                    : 'Not selected'}
            </react_native_1.Text>
            <react_native_1.Text style={styles.meta}>
              Last job: {lastJob ? "".concat(lastJob.orderId, " \u2192 ").concat(lastJob.phone) : '—'}
            </react_native_1.Text>
            <react_native_1.Text style={styles.meta}>Last result: {lastResult}</react_native_1.Text>
          </react_native_1.View>

          <react_native_1.View style={styles.card}>
            <react_native_1.Text style={styles.label}>Activity</react_native_1.Text>
            {logs.length === 0 ? (<react_native_1.Text style={styles.meta}>No activity yet.</react_native_1.Text>) : (logs.map(function (line) { return (<react_native_1.Text key={line} style={styles.logLine}>
                  {line}
                </react_native_1.Text>); }))}
          </react_native_1.View>
        </react_native_1.ScrollView>
      </react_native_safe_area_context_1.SafeAreaView>
    </react_native_safe_area_context_1.SafeAreaProvider>);
}
var styles = react_native_1.StyleSheet.create({
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
    warningCard: {
        backgroundColor: '#fffaeb',
        borderRadius: 12,
        padding: 16,
        gap: 8,
        borderWidth: 1,
        borderColor: '#fedf89',
    },
    warningTitle: {
        fontSize: 15,
        fontWeight: '700',
        color: '#b54708',
    },
    warningText: {
        fontSize: 13,
        color: '#93370d',
    },
    warningButton: {
        marginTop: 4,
        backgroundColor: '#f79009',
        borderRadius: 8,
        paddingVertical: 10,
        alignItems: 'center',
    },
    warningButtonText: {
        color: '#ffffff',
        fontWeight: '600',
        fontSize: 15,
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
exports.default = App;
