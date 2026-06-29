package com.smsgateway

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class SmsGatewayForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_UPDATE -> {
        val status = intent.getStringExtra(EXTRA_STATUS) ?: DEFAULT_STATUS
        val notification = buildNotification(status)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification)
        return START_STICKY
      }
      else -> {
        acquireWakeLock()
        val status = intent?.getStringExtra(EXTRA_STATUS) ?: DEFAULT_STATUS
        startForeground(NOTIFICATION_ID, buildNotification(status))
        return START_STICKY
      }
    }
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) {
      return
    }
    val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock =
      manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:SmsGatewayWakeLock").apply {
        setReferenceCounted(false)
        acquire()
      }
  }

  private fun releaseWakeLock() {
    wakeLock?.let {
      if (it.isHeld) {
        it.release()
      }
    }
    wakeLock = null
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val channel =
      NotificationChannel(
        CHANNEL_ID,
        "SMS Gateway",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Keeps the SMS gateway connected in the background"
        setShowBadge(false)
      }
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(status: String): Notification {
    val launchIntent = Intent(this, MainActivity::class.java)
    val pendingIntent =
      PendingIntent.getActivity(
        this,
        0,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("SMS Gateway")
      .setContentText(status)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(pendingIntent)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  companion object {
    const val CHANNEL_ID = "sms_gateway"
    const val NOTIFICATION_ID = 1001
    const val EXTRA_STATUS = "status"
    const val ACTION_START = "com.smsgateway.action.START_FOREGROUND"
    const val ACTION_UPDATE = "com.smsgateway.action.UPDATE_FOREGROUND"
    const val ACTION_STOP = "com.smsgateway.action.STOP_FOREGROUND"
    const val DEFAULT_STATUS = "Connecting…"
  }
}
