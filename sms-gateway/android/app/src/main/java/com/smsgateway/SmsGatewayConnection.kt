package com.smsgateway

import android.content.Context
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Native OkHttp WebSocket client that mirrors the protocol in src/wsClient.ts.
 * Owned by [SmsGatewayForegroundService] so the connection survives the JS runtime
 * being torn down when the app process is killed.
 */
class SmsGatewayConnection(
  private val appContext: Context,
  private val serverUrl: String,
  private val token: String,
  private val subscriptionId: Int,
  private val listener: Listener,
) {

  interface Listener {
    fun onState(state: String)
    fun onLog(message: String)
    fun onJob(jobId: String, phone: String, orderId: String)
    fun onResult(jobId: String, success: Boolean, error: String?)
  }

  private val client: OkHttpClient =
    OkHttpClient.Builder()
      .pingInterval(0, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build()

  private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()

  @Volatile private var shouldRun = false
  @Volatile private var currentSocket: WebSocket? = null
  @Volatile private var reconnectAttempt = 0
  private var pingTask: ScheduledFuture<*>? = null
  private var reconnectTask: ScheduledFuture<*>? = null

  fun start() {
    if (shouldRun) {
      return
    }
    shouldRun = true
    reconnectAttempt = 0
    connect()
  }

  fun stop() {
    shouldRun = false
    cancelTimers()
    currentSocket?.close(NORMAL_CLOSURE, "client_stop")
    currentSocket = null
    listener.onState(GatewayContract.STATE_DISCONNECTED)
  }

  private fun cancelTimers() {
    pingTask?.cancel(false)
    pingTask = null
    reconnectTask?.cancel(false)
    reconnectTask = null
  }

  private fun scheduleReconnect() {
    if (!shouldRun) {
      return
    }
    val delaySec = Math.min(Math.pow(2.0, reconnectAttempt.toDouble()).toLong(), MAX_BACKOFF_SEC)
    reconnectAttempt += 1
    reconnectTask?.cancel(false)
    reconnectTask = scheduler.schedule({ connect() }, delaySec, TimeUnit.SECONDS)
  }

  private fun connect() {
    if (!shouldRun) {
      return
    }

    cancelTimers()

    val previous = currentSocket
    currentSocket = null
    previous?.close(NORMAL_CLOSURE, "reconnect")

    listener.onState(GatewayContract.STATE_CONNECTING)

    val request = Request.Builder().url(serverUrl).build()
    currentSocket = client.newWebSocket(request, GatewaySocketListener())
  }

  private inner class GatewaySocketListener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      if (webSocket !== currentSocket) {
        return
      }
      webSocket.send(JSONObject().put("type", "auth").put("token", token).toString())
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      if (webSocket !== currentSocket) {
        return
      }

      val msg =
        try {
          JSONObject(text)
        } catch (_: Exception) {
          return
        }

      when (msg.optString("type")) {
        "auth_ok" -> {
          reconnectAttempt = 0
          listener.onState(GatewayContract.STATE_CONNECTED)
          startPing(webSocket)
        }
        "auth_failed" -> {
          listener.onState(GatewayContract.STATE_AUTH_FAILED)
          shouldRun = false
          cancelTimers()
          webSocket.close(NORMAL_CLOSURE, "auth_failed")
        }
        "sms" -> {
          val job = msg.optJSONObject("job") ?: return
          handleSmsJob(webSocket, job)
        }
      }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(NORMAL_CLOSURE, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      handleDisconnect(webSocket)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (webSocket === currentSocket) {
        listener.onLog("WebSocket error: ${t.message ?: t.javaClass.simpleName}")
      }
      handleDisconnect(webSocket)
    }
  }

  private fun handleDisconnect(webSocket: WebSocket) {
    if (webSocket !== currentSocket) {
      return
    }
    currentSocket = null
    cancelTimers()
    if (shouldRun) {
      listener.onState(GatewayContract.STATE_DISCONNECTED)
      scheduleReconnect()
    }
  }

  private fun startPing(webSocket: WebSocket) {
    pingTask?.cancel(false)
    pingTask =
      scheduler.scheduleWithFixedDelay(
        {
          if (webSocket === currentSocket) {
            webSocket.send(JSONObject().put("type", "ping").toString())
          }
        },
        PING_INTERVAL_SEC,
        PING_INTERVAL_SEC,
        TimeUnit.SECONDS,
      )
  }

  private fun handleSmsJob(webSocket: WebSocket, job: JSONObject) {
    val jobId = job.optString("id")
    val phone = job.optString("phone")
    val message = job.optString("message")
    val orderId = job.optString("orderId")

    listener.onJob(jobId, phone, orderId)

    // SMS sending is blocking; run it off the socket callback thread.
    scheduler.execute {
      try {
        SmsSender.send(appContext, phone, message, subscriptionId)
        reportResult(webSocket, jobId, true, null)
      } catch (e: Exception) {
        val error = e.message ?: "Failed to send SMS"
        reportResult(webSocket, jobId, false, error)
      }
    }
  }

  private fun reportResult(webSocket: WebSocket, jobId: String, success: Boolean, error: String?) {
    if (webSocket === currentSocket) {
      val payload =
        JSONObject().put("type", "result").put("jobId", jobId).put("success", success)
      if (error != null) {
        payload.put("error", error)
      }
      webSocket.send(payload.toString())
    }
    listener.onResult(jobId, success, error)
  }

  companion object {
    private const val NORMAL_CLOSURE = 1000
    private const val PING_INTERVAL_SEC = 30L
    private const val MAX_BACKOFF_SEC = 30L
  }
}
