package com.smsgateway

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = GatewayServiceModule.NAME)
class GatewayServiceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun start(status: String, promise: Promise) {
    try {
      val intent =
        Intent(reactContext, SmsGatewayForegroundService::class.java).apply {
          action = SmsGatewayForegroundService.ACTION_START
          putExtra(SmsGatewayForegroundService.EXTRA_STATUS, status)
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
  fun updateStatus(status: String, promise: Promise) {
    try {
      val intent =
        Intent(reactContext, SmsGatewayForegroundService::class.java).apply {
          action = SmsGatewayForegroundService.ACTION_UPDATE
          putExtra(SmsGatewayForegroundService.EXTRA_STATUS, status)
        }
      reactContext.startService(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("FOREGROUND_UPDATE_FAILED", e.message, e)
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

  companion object {
    const val NAME = "GatewayService"
  }
}
