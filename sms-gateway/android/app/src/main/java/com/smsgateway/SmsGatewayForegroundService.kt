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

class SmsGatewayForegroundService : Service(), SmsGatewayConnection.Listener {

  private var wakeLock: PowerManager.WakeLock? = null
  private var connection: SmsGatewayConnection? = null
  @Volatile private var currentState: String = GatewayContract.STATE_DISCONNECTED

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        setRunningFlag(false)
        stopConnection()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return START_NOT_STICKY
      }
      else -> {
        // ACTION_START (with fresh config) or a null intent from START_STICKY restart.
        if (intent?.action == ACTION_START) {
          persistConfig(intent)
        }
        val started = startFromPersistedConfig()
        if (!started) {
          stopSelf()
          return START_NOT_STICKY
        }
        return START_STICKY
      }
    }
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Keep running when the user swipes the app away — do not call stopSelf().
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    stopConnection()
    releaseWakeLock()
    super.onDestroy()
  }

  private fun startFromPersistedConfig(): Boolean {
    val prefs = getSharedPreferences(GatewayContract.PREFS_NAME, Context.MODE_PRIVATE)
    if (!prefs.getBoolean(GatewayContract.KEY_RUNNING, false)) {
      return false
    }
    val serverUrl = prefs.getString(GatewayContract.KEY_SERVER_URL, null) ?: return false
    val token = prefs.getString(GatewayContract.KEY_TOKEN, null) ?: return false
    val subscriptionId = prefs.getInt(GatewayContract.KEY_SUBSCRIPTION_ID, -1)

    acquireWakeLock()
    startForeground(NOTIFICATION_ID, buildNotification(statusText(currentState)))

    stopConnection()
    val conn = SmsGatewayConnection(applicationContext, serverUrl, token, subscriptionId, this)
    connection = conn
    conn.start()
    return true
  }

  private fun persistConfig(intent: Intent) {
    val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL) ?: return
    val token = intent.getStringExtra(EXTRA_TOKEN) ?: return
    val subscriptionId = intent.getIntExtra(EXTRA_SUBSCRIPTION_ID, -1)
    getSharedPreferences(GatewayContract.PREFS_NAME, Context.MODE_PRIVATE).edit().apply {
      putString(GatewayContract.KEY_SERVER_URL, serverUrl)
      putString(GatewayContract.KEY_TOKEN, token)
      putInt(GatewayContract.KEY_SUBSCRIPTION_ID, subscriptionId)
      putBoolean(GatewayContract.KEY_RUNNING, true)
      apply()
    }
  }

  private fun setRunningFlag(running: Boolean) {
    getSharedPreferences(GatewayContract.PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(GatewayContract.KEY_RUNNING, running)
      .apply()
  }

  private fun stopConnection() {
    connection?.stop()
    connection = null
  }

  // --- SmsGatewayConnection.Listener ---

  override fun onState(state: String) {
    currentState = state
    getSharedPreferences(GatewayContract.PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(GatewayContract.KEY_LAST_STATE, state)
      .apply()
    updateNotification(statusText(state))
    val intent =
      Intent(GatewayContract.ACTION_EVENT).apply {
        setPackage(packageName)
        putExtra(GatewayContract.EXTRA_EVENT_TYPE, GatewayContract.EVENT_STATE)
        putExtra(GatewayContract.EXTRA_STATE, state)
      }
    sendBroadcast(intent)
  }

  override fun onLog(message: String) {
    val intent =
      Intent(GatewayContract.ACTION_EVENT).apply {
        setPackage(packageName)
        putExtra(GatewayContract.EXTRA_EVENT_TYPE, GatewayContract.EVENT_LOG)
        putExtra(GatewayContract.EXTRA_MESSAGE, message)
      }
    sendBroadcast(intent)
  }

  override fun onJob(jobId: String, phone: String, orderId: String) {
    updateNotification("Sending SMS to $phone")
    val intent =
      Intent(GatewayContract.ACTION_EVENT).apply {
        setPackage(packageName)
        putExtra(GatewayContract.EXTRA_EVENT_TYPE, GatewayContract.EVENT_JOB)
        putExtra(GatewayContract.EXTRA_JOB_ID, jobId)
        putExtra(GatewayContract.EXTRA_PHONE, phone)
        putExtra(GatewayContract.EXTRA_ORDER_ID, orderId)
      }
    sendBroadcast(intent)
  }

  override fun onResult(jobId: String, success: Boolean, error: String?) {
    updateNotification(
      if (success) statusText(GatewayContract.STATE_CONNECTED)
      else "Last send failed: ${error ?: "unknown error"}"
    )
    val intent =
      Intent(GatewayContract.ACTION_EVENT).apply {
        setPackage(packageName)
        putExtra(GatewayContract.EXTRA_EVENT_TYPE, GatewayContract.EVENT_RESULT)
        putExtra(GatewayContract.EXTRA_JOB_ID, jobId)
        putExtra(GatewayContract.EXTRA_SUCCESS, success)
        putExtra(GatewayContract.EXTRA_ERROR, error)
      }
    sendBroadcast(intent)
  }

  // --- Wake lock ---

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

  // --- Notification ---

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

  private fun updateNotification(status: String) {
    val manager = getSystemService(NotificationManager::class.java)
    manager.notify(NOTIFICATION_ID, buildNotification(status))
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

  private fun statusText(state: String): String =
    when (state) {
      GatewayContract.STATE_CONNECTED -> "Connected — listening for SMS jobs"
      GatewayContract.STATE_CONNECTING -> "Connecting to server…"
      GatewayContract.STATE_AUTH_FAILED -> "Authentication failed"
      else -> "Disconnected"
    }

  companion object {
    const val CHANNEL_ID = "sms_gateway"
    const val NOTIFICATION_ID = 1001
    const val ACTION_START = "com.smsgateway.action.START_FOREGROUND"
    const val ACTION_STOP = "com.smsgateway.action.STOP_FOREGROUND"
    const val EXTRA_SERVER_URL = "serverUrl"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_SUBSCRIPTION_ID = "subscriptionId"

    fun start(context: Context) {
      val intent =
        Intent(context, SmsGatewayForegroundService::class.java).apply { action = ACTION_START }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }
}
