package com.smsgateway

/**
 * Shared constants for the SMS gateway foreground service, its native connection,
 * the RN bridge module, and the boot receiver.
 */
object GatewayContract {

  // Connection states — mirror the ConnectionState union in src/wsClient.ts.
  const val STATE_DISCONNECTED = "disconnected"
  const val STATE_CONNECTING = "connecting"
  const val STATE_CONNECTED = "connected"
  const val STATE_AUTH_FAILED = "auth_failed"

  // SharedPreferences (lets the service reconnect after a process kill / reboot).
  const val PREFS_NAME = "sms_gateway_prefs"
  const val KEY_SERVER_URL = "server_url"
  const val KEY_TOKEN = "token"
  const val KEY_SUBSCRIPTION_ID = "subscription_id"
  const val KEY_RUNNING = "running"
  const val KEY_LAST_STATE = "last_state"

  // Broadcast the service sends; GatewayServiceModule forwards it to JS.
  const val ACTION_EVENT = "com.smsgateway.GATEWAY_EVENT"
  const val EXTRA_EVENT_TYPE = "eventType"
  const val EXTRA_STATE = "state"
  const val EXTRA_MESSAGE = "message"
  const val EXTRA_JOB_ID = "jobId"
  const val EXTRA_PHONE = "phone"
  const val EXTRA_ORDER_ID = "orderId"
  const val EXTRA_SUCCESS = "success"
  const val EXTRA_ERROR = "error"

  // Event types carried by ACTION_EVENT broadcasts and emitted to JS.
  const val EVENT_STATE = "state"
  const val EVENT_LOG = "log"
  const val EVENT_JOB = "job"
  const val EVENT_RESULT = "result"
}
