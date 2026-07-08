package com.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

@ReactModule(name = GatewayServiceModule.NAME)
class GatewayServiceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var eventReceiver: BroadcastReceiver? = null

  override fun getName(): String = NAME

  override fun initialize() {
    super.initialize()
    registerEventReceiver()
  }

  override fun invalidate() {
    unregisterEventReceiver()
    super.invalidate()
  }

  @ReactMethod
  fun start(serverUrl: String, token: String, subscriptionId: Double, promise: Promise) {
    try {
      val intent =
        Intent(reactContext, SmsGatewayForegroundService::class.java).apply {
          action = SmsGatewayForegroundService.ACTION_START
          putExtra(SmsGatewayForegroundService.EXTRA_SERVER_URL, serverUrl)
          putExtra(SmsGatewayForegroundService.EXTRA_TOKEN, token)
          putExtra(SmsGatewayForegroundService.EXTRA_SUBSCRIPTION_ID, subscriptionId.toInt())
        }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("FOREGROUND_START_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val intent =
        Intent(reactContext, SmsGatewayForegroundService::class.java).apply {
          action = SmsGatewayForegroundService.ACTION_STOP
        }
      reactContext.startService(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("FOREGROUND_STOP_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    try {
      val prefs =
        reactContext.getSharedPreferences(GatewayContract.PREFS_NAME, Context.MODE_PRIVATE)
      val map = Arguments.createMap()
      map.putBoolean("running", prefs.getBoolean(GatewayContract.KEY_RUNNING, false))
      map.putString(
        "state",
        prefs.getString(GatewayContract.KEY_LAST_STATE, GatewayContract.STATE_DISCONNECTED),
      )
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("STATUS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    try {
      val manager = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
      promise.resolve(manager.isIgnoringBatteryOptimizations(reactContext.packageName))
    } catch (e: Exception) {
      promise.reject("BATTERY_CHECK_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun requestIgnoreBatteryOptimizations(promise: Promise) {
    try {
      val manager = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
      if (manager.isIgnoringBatteryOptimizations(reactContext.packageName)) {
        promise.resolve(true)
        return
      }
      val intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
          data = Uri.parse("package:${reactContext.packageName}")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      val activity = reactContext.currentActivity
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        reactContext.startActivity(intent)
      }
      promise.resolve(false)
    } catch (e: Exception) {
      promise.reject("BATTERY_REQUEST_FAILED", e.message, e)
    }
  }

  // Required so NativeEventEmitter does not warn on the JS side.
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Double) {}

  private fun registerEventReceiver() {
    if (eventReceiver != null) {
      return
    }
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          if (intent == null) return
          emitEvent(intent)
        }
      }
    eventReceiver = receiver
    ContextCompat.registerReceiver(
      reactContext,
      receiver,
      IntentFilter(GatewayContract.ACTION_EVENT),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  private fun unregisterEventReceiver() {
    eventReceiver?.let {
      try {
        reactContext.unregisterReceiver(it)
      } catch (_: Exception) {
        // Already unregistered.
      }
    }
    eventReceiver = null
  }

  private fun emitEvent(intent: Intent) {
    val type = intent.getStringExtra(GatewayContract.EXTRA_EVENT_TYPE) ?: return
    val payload: WritableMap = Arguments.createMap()
    payload.putString("type", type)

    when (type) {
      GatewayContract.EVENT_STATE ->
        payload.putString("state", intent.getStringExtra(GatewayContract.EXTRA_STATE))
      GatewayContract.EVENT_LOG ->
        payload.putString("message", intent.getStringExtra(GatewayContract.EXTRA_MESSAGE))
      GatewayContract.EVENT_JOB -> {
        payload.putString("jobId", intent.getStringExtra(GatewayContract.EXTRA_JOB_ID))
        payload.putString("phone", intent.getStringExtra(GatewayContract.EXTRA_PHONE))
        payload.putString("orderId", intent.getStringExtra(GatewayContract.EXTRA_ORDER_ID))
      }
      GatewayContract.EVENT_RESULT -> {
        payload.putString("jobId", intent.getStringExtra(GatewayContract.EXTRA_JOB_ID))
        payload.putBoolean("success", intent.getBooleanExtra(GatewayContract.EXTRA_SUCCESS, false))
        intent.getStringExtra(GatewayContract.EXTRA_ERROR)?.let { payload.putString("error", it) }
      }
    }

    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(EVENT_NAME, payload)
  }

  companion object {
    const val NAME = "GatewayService"
    const val EVENT_NAME = "GatewayEvent"
  }
}
