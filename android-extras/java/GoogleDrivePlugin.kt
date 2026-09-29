package com.adam.injectiontracker

import android.accounts.Account
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.identity.RevokeAccessRequest
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/*
 * Google sign-in + backups to the app's private folder in the user's Google Drive (appDataFolder:
 * hidden from the Drive UI, only this app can read it). Uses Google Play services' AuthorizationClient,
 * so there are no passwords or refresh tokens in the app.
 *
 * JS: Capacitor.Plugins.GoogleDrive
 *   signIn() -> {email, name}              (shows Google's account picker / consent)
 *   status() -> {signedIn, email, name}    (never shows UI)
 *   upload({name, data, keep}) -> {id, name, modifiedTime}
 *   list() -> {files:[{id, name, modifiedTime, size}]}
 *   download({id}) -> {data}
 *   signOut({email})
 * Errors use code "consent" when the user has to sign in again.
 */
@CapacitorPlugin(name = "GoogleDrive")
class GoogleDrivePlugin : Plugin() {
    private val scopes = listOf(
        Scope("https://www.googleapis.com/auth/drive.appdata"),
        Scope("email"),
        Scope("profile")
    )
    private val io = Executors.newSingleThreadExecutor()
    private var launcher: ActivityResultLauncher<IntentSenderRequest>? = null
    private var pendingCall: PluginCall? = null
    private var pendingNext: ((String) -> Unit)? = null

    override fun load() {
        launcher = activity.activityResultRegistry.register("ets-google-auth", ActivityResultContracts.StartIntentSenderForResult()) { res ->
            val call = pendingCall; val next = pendingNext
            pendingCall = null; pendingNext = null
            if (call == null || next == null) return@register
            try {
                val r = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(res.data)
                val t = r.accessToken
                if (t == null) call.reject("Google sign-in was cancelled.", "cancelled") else next(t)
            } catch (e: ApiException) {
                call.reject("Google sign-in was cancelled.", "cancelled")
            } catch (e: Exception) {
                call.reject(e.message ?: "Google sign-in failed.")
            }
        }
    }

    /** Gets a fresh access token. With interactive = false it never shows UI and rejects with "consent" instead. */
    private fun token(call: PluginCall, interactive: Boolean, next: (String) -> Unit) {
        val req = AuthorizationRequest.builder().setRequestedScopes(scopes).build()
        Identity.getAuthorizationClient(activity).authorize(req)
            .addOnSuccessListener { r ->
                if (r.hasResolution()) {
                    val pi = r.pendingIntent
                    if (!interactive || pi == null || launcher == null) {
                        call.reject("Sign in with Google again to use Drive backup.", "consent")
                    } else {
                        pendingCall?.reject("Replaced by a newer sign-in.", "cancelled")
                        pendingCall = call; pendingNext = next
                        launcher!!.launch(IntentSenderRequest.Builder(pi.intentSender).build())
                    }
                } else {
                    val t = r.accessToken
                    if (t == null) call.reject("Google didn't return access.", "consent") else next(t)
                }
            }
            .addOnFailureListener { e -> call.reject("Google sign-in isn't available: ${e.message}", "unavailable") }
    }

    private class HttpResult(val code: Int, val body: String)

    private fun http(method: String, url: String, token: String, body: ByteArray? = null, contentType: String? = null): HttpResult {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 20000; c.readTimeout = 60000
            c.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                c.doOutput = true
                if (contentType != null) c.setRequestProperty("Content-Type", contentType)
                c.setFixedLengthStreamingMode(body.size)
                c.outputStream.use { it.write(body) }
            }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val out = ByteArrayOutputStream()
            stream?.use { it.copyTo(out) }
            return HttpResult(code, out.toString("UTF-8"))
        } finally { c.disconnect() }
    }

    private fun fail(call: PluginCall, r: HttpResult) {
        val reason = try { JSONObject(r.body).optJSONObject("error")?.optJSONArray("errors")?.optJSONObject(0)?.optString("reason") ?: "" } catch (_: Exception) { "" }
        when {
            r.code == 401 || reason == "insufficientPermissions" || reason == "authError" ->
                call.reject("Google Drive needs you to sign in again.", "consent")
            reason == "storageQuotaExceeded" || reason == "quotaExceeded" ->
                call.reject("Your Google storage is full, so the backup couldn't be saved.", "quota")
            reason == "userRateLimitExceeded" || reason == "rateLimitExceeded" || r.code == 429 ->
                call.reject("Google Drive is busy. Try again in a minute.", "rate")
            else -> call.reject("Google Drive error ${r.code}${if (reason.isNotEmpty()) " ($reason)" else ""}.", "http")
        }
    }

    private fun userInfo(token: String): JSObject {
        val o = JSObject()
        try {
            val r = http("GET", "https://www.googleapis.com/oauth2/v3/userinfo", token)
            if (r.code == 200) { val j = JSONObject(r.body); o.put("email", j.optString("email")); o.put("name", j.optString("name")) }
        } catch (_: Exception) {}
        return o
    }

    @PluginMethod
    fun signIn(call: PluginCall) {
        token(call, true) { t -> io.execute { val u = userInfo(t); u.put("signedIn", true); call.resolve(u) } }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val req = AuthorizationRequest.builder().setRequestedScopes(scopes).build()
        Identity.getAuthorizationClient(activity).authorize(req)
            .addOnSuccessListener { r ->
                val t = r.accessToken
                if (r.hasResolution() || t == null) { val o = JSObject(); o.put("signedIn", false); call.resolve(o) }
                else io.execute { val u = userInfo(t); u.put("signedIn", true); call.resolve(u) }
            }
            .addOnFailureListener { val o = JSObject(); o.put("signedIn", false); o.put("unavailable", true); call.resolve(o) }
    }

    private fun listFiles(t: String): HttpResult =
        http("GET", "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&pageSize=100&orderBy=" +
                URLEncoder.encode("modifiedTime desc", "UTF-8") + "&fields=" + URLEncoder.encode("files(id,name,modifiedTime,size)", "UTF-8"), t)

    @PluginMethod
    fun upload(call: PluginCall) {
        val name = call.getString("name") ?: "backup.json"
        val data = call.getString("data") ?: return call.reject("Nothing to upload.")
        val keep = (call.getInt("keep") ?: 10).coerceIn(1, 50)
        val interactive = call.getBoolean("interactive", false) == true
        token(call, interactive) { t ->
            io.execute {
                try {
                    val boundary = "ets" + System.currentTimeMillis()
                    val meta = JSONObject().put("name", name).put("parents", org.json.JSONArray().put("appDataFolder")).put("mimeType", "application/json")
                    val body = ("--$boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n$meta\r\n" +
                            "--$boundary\r\nContent-Type: application/json\r\n\r\n$data\r\n--$boundary--").toByteArray(Charsets.UTF_8)
                    val r = http("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size", t, body, "multipart/related; boundary=$boundary")
                    if (r.code !in 200..299) return@execute fail(call, r)
                    // keep only the newest backups
                    try {
                        val l = listFiles(t)
                        if (l.code == 200) {
                            val files = JSONObject(l.body).optJSONArray("files")
                            if (files != null) for (i in keep until files.length()) {
                                http("DELETE", "https://www.googleapis.com/drive/v3/files/" + files.getJSONObject(i).getString("id"), t)
                            }
                        }
                    } catch (_: Exception) {}
                    call.resolve(JSObject(r.body))
                } catch (e: Exception) { call.reject("Upload failed: ${e.message}", "network") }
            }
        }
    }

    @PluginMethod
    fun list(call: PluginCall) {
        token(call, call.getBoolean("interactive", false) == true) { t ->
            io.execute {
                try {
                    val r = listFiles(t)
                    if (r.code != 200) return@execute fail(call, r)
                    val files = JSONObject(r.body).optJSONArray("files") ?: org.json.JSONArray()
                    val o = JSObject(); o.put("files", JSArray(files.toString())); call.resolve(o)
                } catch (e: Exception) { call.reject("Couldn't list backups: ${e.message}", "network") }
            }
        }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("No backup chosen.")
        token(call, call.getBoolean("interactive", false) == true) { t ->
            io.execute {
                try {
                    val r = http("GET", "https://www.googleapis.com/drive/v3/files/" + URLEncoder.encode(id, "UTF-8") + "?alt=media", t)
                    if (r.code != 200) return@execute fail(call, r)
                    val o = JSObject(); o.put("data", r.body); call.resolve(o)
                } catch (e: Exception) { call.reject("Download failed: ${e.message}", "network") }
            }
        }
    }

    @PluginMethod
    fun signOut(call: PluginCall) {
        val email = call.getString("email")
        if (email.isNullOrEmpty()) return call.resolve()
        try {
            val req = RevokeAccessRequest.builder().setAccount(Account(email, "com.google")).setScopes(scopes).build()
            Identity.getAuthorizationClient(activity).revokeAccess(req)
                .addOnSuccessListener { call.resolve() }
                .addOnFailureListener { call.resolve() }
        } catch (e: Throwable) { call.resolve() }
    }
}
