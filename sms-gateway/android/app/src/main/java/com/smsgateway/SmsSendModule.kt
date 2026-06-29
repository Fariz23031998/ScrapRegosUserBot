package com.smsgateway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
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
      if (!hasPhoneStatePermission()) {
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
      if (
        reactContext.checkSelfPermission(Manifest.permission.SEND_SMS) !=
          PackageManager.PERMISSION_GRANTED
      ) {
        promise.reject("SMS_PERMISSION_DENIED", "SEND_SMS permission is not granted")
        return
      }

      val normalizedPhone = normalizePhone(phone)
      if (normalizedPhone == null) {
        promise.reject("SMS_INVALID_PHONE", "Invalid phone number: $phone")
        return
      }

      val smsManager = getSmsManager(subscriptionId.toInt())
      val parts = smsManager.divideMessage(message)
      if (parts.size <= 1) {
        smsManager.sendTextMessage(normalizedPhone, null, message, null, null)
      } else {
        smsManager.sendMultipartTextMessage(normalizedPhone, null, parts, null, null)
      }

      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("SMS_PERMISSION_DENIED", e.message, e)
    } catch (e: Exception) {
      promise.reject("SMS_SEND_FAILED", e.message ?: "Failed to send SMS", e)
    }
  }

  private fun hasPhoneStatePermission(): Boolean {
    return reactContext.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) ==
      PackageManager.PERMISSION_GRANTED
  }

  private fun buildSimCardsArray(): WritableArray {
    val array = Arguments.createArray()
    val subscriptionManager =
      reactContext.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
    val subscriptions = subscriptionManager.activeSubscriptionInfoList ?: emptyList()

    for (info in subscriptions) {
      val map = Arguments.createMap()
      map.putInt("subscriptionId", info.subscriptionId)
      map.putInt("slotIndex", info.simSlotIndex)
      map.putString("displayName", info.displayName?.toString() ?: "SIM ${info.simSlotIndex + 1}")
      map.putString("carrierName", info.carrierName?.toString() ?: "")
      map.putString("phoneNumber", info.number ?: "")
      array.pushMap(map)
    }

    return array
  }

  private fun getSmsManager(subscriptionId: Int): SmsManager {
    if (subscriptionId >= 0) {
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        reactContext.getSystemService(SmsManager::class.java)
          .createForSubscriptionId(subscriptionId)
      } else {
        @Suppress("DEPRECATION")
        SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
      }
    }

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      reactContext.getSystemService(SmsManager::class.java)
    } else {
      @Suppress("DEPRECATION")
      SmsManager.getDefault()
    }
  }

  private fun normalizePhone(phone: String): String? {
    val digits = phone.filter { it.isDigit() }
    if (digits.length == 12 && digits.startsWith("998")) {
      return "+$digits"
    }
    if (digits.length == 9 && digits.startsWith("9")) {
      return "+998$digits"
    }
    if (digits.length >= 10) {
      return "+$digits"
    }
    return null
  }

  companion object {
    const val NAME = "SmsSend"
  }
}
