# SMS Gateway (Android)

React Native Android app that connects to the backend WebSocket and sends queued payment-link SMS messages.

## Setup

```bash
cd sms-gateway
npm install
```

## Run on Android

```bash
npm run android
```

Use a physical device with a SIM for real SMS delivery. On the Android emulator, use:

`ws://10.0.2.2:3000/sms-gateway/ws`

## Configuration

Enter in the app:

- **Server URL** — e.g. `wss://aserver.tech/sms-gateway/ws`
- **Gateway token** — same value as `SMS_GATEWAY_TOKEN` in backend `.env`

Settings are persisted locally on the device.

## Background operation

When you tap **Connect**, the app starts an Android foreground service with a persistent notification. This keeps the WebSocket connection alive when you switch apps or lock the screen.

- Allow **Notifications** when prompted (Android 13+).
- Disable battery optimization for this app on the gateway phone if the connection drops in the background (Settings → Apps → SMS Gateway → Battery → Unrestricted).

## Permissions

The app requests **Send SMS** at runtime. Internet access is declared in the manifest for WebSocket connectivity.

## Backend docs

See [docs/sms-gateway.md](../docs/sms-gateway.md) in the repo root.

## Build APK

**JDK 21 required.** Android Gradle Plugin native builds fail on JDK 22+ (`configureCMakeRelWithDebInfo` / restricted `System` methods). The `android:apk:*` npm scripts auto-select JDK 21 on Windows when installed at `C:\Program Files\Java\jdk-21.0.10`, or use `JAVA_HOME` if it points to JDK 21.

### Debug APK (no signing setup)

```bash
cd sms-gateway
npm run android:apk:debug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

### Release APK (signed, for production gateway phone)

**1. Create a keystore** (once):

```bash
cd sms-gateway/android/app
keytool -genkeypair -v -storetype PKCS12 -keystore sms-gateway-release.keystore -alias smsgateway -keyalg RSA -keysize 2048 -validity 10000
```

**2. Configure signing:**

```bash
cd sms-gateway/android
copy signing.properties.example signing.properties
```

Edit `signing.properties` with your keystore password and paths. The example expects the keystore at `android/app/sms-gateway-release.keystore`.

**3. Build:**

```bash
cd sms-gateway
npm run android:apk:release
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

Copy the APK to the gateway phone and install it (enable **Install unknown apps** if sideloading).

> Keep the keystore and `signing.properties` safe — you need the same keystore to publish updates to the same app.
