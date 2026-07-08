package com.smsgateway

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = SmsSendModule.NAME)
class SmsSendModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun getSimCards(promise: Promise) {
    try {
      if (!SmsSender.hasPhoneStatePermission(reactContext)) {
        promise.reject("PHONE_STATE_DENIED", "READ_PHONE_STATE permission is not granted")
        return
      }

      promise.resolve(buildSimCardsArray())
    } catch (e: SecurityException) {
      promise.reject("PHONE_STATE_DENIED", e.message, e)
    } catch (e: Exception) {
      promise.reject("SIM_LIST_FAILED", e.message ?: "Failed to list SIM cards", e)
    }
  }

  @ReactMethod
  fun send(phone: String, message: String, subscriptionId: Double, promise: Promise) {
    try {
      SmsSender.send(reactContext, phone, message, subscriptionId.toInt())
      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("SMS_PERMISSION_DENIED", e.message, e)
    } catch (e: IllegalArgumentException) {
      promise.reject("SMS_INVALID_PHONE", e.message, e)
    } catch (e: Exception) {
      promise.reject("SMS_SEND_FAILED", e.message ?: "Failed to send SMS", e)
    }
  }

  private fun buildSimCardsArray(): WritableArray {
    val array = Arguments.createArray()
    for (sim in SmsSender.listSimCards(reactContext)) {
      val map = Arguments.createMap()
      map.putInt("subscriptionId", sim.subscriptionId)
      map.putInt("slotIndex", sim.slotIndex)
      map.putString("displayName", sim.displayName)
      map.putString("carrierName", sim.carrierName)
      map.putString("phoneNumber", sim.phoneNumber)
      array.pushMap(map)
    }
    return array
  }

  companion object {
    const val NAME = "SmsSend"
  }
}
