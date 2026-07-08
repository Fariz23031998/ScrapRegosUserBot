package com.smsgateway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager

/**
 * Shared SMS + SIM logic used by both the React Native bridge module
 * ([SmsSendModule]) and the native foreground service ([SmsGatewayConnection]).
 */
object SmsSender {

  data class SimCard(
    val subscriptionId: Int,
    val slotIndex: Int,
    val displayName: String,
    val carrierName: String,
    val phoneNumber: String,
  )

  fun hasSmsPermission(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.SEND_SMS) ==
      PackageManager.PERMISSION_GRANTED

  fun hasPhoneStatePermission(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) ==
      PackageManager.PERMISSION_GRANTED

  /**
   * Sends an SMS. Throws [SecurityException] when the permission is missing and
   * [IllegalArgumentException] when the phone number cannot be normalized.
   */
  fun send(context: Context, phone: String, message: String, subscriptionId: Int) {
    if (!hasSmsPermission(context)) {
      throw SecurityException("SEND_SMS permission is not granted")
    }

    val normalizedPhone =
      normalizePhone(phone) ?: throw IllegalArgumentException("Invalid phone number: $phone")

    val smsManager = getSmsManager(context, subscriptionId)
    val parts = smsManager.divideMessage(message)
    if (parts.size <= 1) {
      smsManager.sendTextMessage(normalizedPhone, null, message, null, null)
    } else {
      smsManager.sendMultipartTextMessage(normalizedPhone, null, parts, null, null)
    }
  }

  fun listSimCards(context: Context): List<SimCard> {
    if (!hasPhoneStatePermission(context)) {
      throw SecurityException("READ_PHONE_STATE permission is not granted")
    }

    val subscriptionManager =
      context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
    val subscriptions = subscriptionManager.activeSubscriptionInfoList ?: emptyList()

    return subscriptions.map { info ->
      SimCard(
        subscriptionId = info.subscriptionId,
        slotIndex = info.simSlotIndex,
        displayName = info.displayName?.toString() ?: "SIM ${info.simSlotIndex + 1}",
        carrierName = info.carrierName?.toString() ?: "",
        phoneNumber = info.number ?: "",
      )
    }
  }

  private fun getSmsManager(context: Context, subscriptionId: Int): SmsManager {
    if (subscriptionId >= 0) {
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getSystemService(SmsManager::class.java).createForSubscriptionId(subscriptionId)
      } else {
        @Suppress("DEPRECATION")
        SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
      }
    }

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(SmsManager::class.java)
    } else {
      @Suppress("DEPRECATION")
      SmsManager.getDefault()
    }
  }

  fun normalizePhone(phone: String): String? {
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
}
