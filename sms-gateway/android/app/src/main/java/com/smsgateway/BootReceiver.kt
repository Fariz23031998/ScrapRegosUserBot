package com.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts the gateway foreground service after a device reboot, but only if the
 * user had it running (KEY_RUNNING) before shutdown.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    if (
      action != Intent.ACTION_BOOT_COMPLETED &&
      action != "android.intent.action.QUICKBOOT_POWERON" &&
      action != "com.htc.intent.action.QUICKBOOT_POWERON"
    ) {
      return
    }

    val prefs = context.getSharedPreferences(GatewayContract.PREFS_NAME, Context.MODE_PRIVATE)
    if (!prefs.getBoolean(GatewayContract.KEY_RUNNING, false)) {
      return
    }

    SmsGatewayForegroundService.start(context)
  }
}
