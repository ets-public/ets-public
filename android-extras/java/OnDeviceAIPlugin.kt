package com.adam.injectiontracker

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * On-device AI for the full app: Gemini Nano through ML Kit's GenAI Prompt API (Google AICore), and ML Kit text
 * recognition for photos. Everything runs on the phone; nothing is sent anywhere by this plugin.
 * JS: Capacitor.Plugins.OnDeviceAI.status() -> {status: available|downloadable|downloading|unavailable, error?}
 *     .download() (events "aiDownload" {state, bytes}) -> {status}
 *     .generate({prompt, image?: data URL, temperature?, maxOutputTokens?}) -> {text}
 *     .ocr({image: data URL}) -> {text}: the photo's text, row by row as printed
 * Gemini Nano only runs while the app is on screen, within a per-app quota, and not on phones with an unlocked
 * bootloader; errors come back as rejections whose message names the reason.
 */
@CapacitorPlugin(name = "OnDeviceAI")
class OnDeviceAIPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var model: GenerativeModel? = null

    private fun gen(): GenerativeModel = model ?: Generation.getClient().also { model = it }

    private fun statusName(s: Int): String = when (s) {
        FeatureStatus.AVAILABLE -> "available"
        FeatureStatus.DOWNLOADABLE -> "downloadable"
        FeatureStatus.DOWNLOADING -> "downloading"
        else -> "unavailable"
    }

    private fun why(e: Throwable): String = (e.javaClass.simpleName + ": " + (e.message ?: "")).take(300)

    @PluginMethod
    fun status(call: PluginCall) {
        scope.launch {
            try {
                call.resolve(JSObject().put("status", statusName(gen().checkStatus())))
            } catch (e: Throwable) {
                call.resolve(JSObject().put("status", "unavailable").put("error", why(e)))
            }
        }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        scope.launch {
            var failed: String? = null
            try {
                gen().download().collect { st ->
                    when (st) {
                        is DownloadStatus.DownloadStarted -> notifyListeners("aiDownload", JSObject().put("state", "started").put("bytes", 0))
                        is DownloadStatus.DownloadProgress -> notifyListeners("aiDownload", JSObject().put("state", "progress").put("bytes", st.totalBytesDownloaded))
                        is DownloadStatus.DownloadCompleted -> notifyListeners("aiDownload", JSObject().put("state", "done"))
                        is DownloadStatus.DownloadFailed -> failed = st.e.message ?: "download failed"
                        else -> {}
                    }
                }
            } catch (e: Throwable) {
                failed = why(e)
            }
            if (failed != null) call.reject(failed) else call.resolve(JSObject().put("status", "available"))
        }
    }

    @PluginMethod
    fun generate(call: PluginCall) {
        val prompt = call.getString("prompt")
        if (prompt.isNullOrBlank()) { call.reject("prompt missing"); return }
        val image = call.getString("image")
        val temp = (call.getDouble("temperature") ?: 0.1).toFloat()
        val maxOut = call.getInt("maxOutputTokens") ?: 600
        scope.launch {
            try {
                val bmp = image?.let { decode(it) }
                val req = if (bmp != null) {
                    generateContentRequest(ImagePart(bmp), TextPart(prompt)) { temperature = temp; maxOutputTokens = maxOut }
                } else {
                    generateContentRequest(TextPart(prompt)) { temperature = temp; maxOutputTokens = maxOut }
                }
                val res = gen().generateContent(req)
                val text = res.candidates.firstOrNull()?.text ?: ""
                call.resolve(JSObject().put("text", text))
            } catch (e: Throwable) {
                call.reject(why(e))
            }
        }
    }

    @PluginMethod
    fun ocr(call: PluginCall) {
        val image = call.getString("image")
        val bmp = image?.let { decode(it) }
        if (bmp == null) { call.reject("unreadable image"); return }
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
            .process(InputImage.fromBitmap(bmp, 0))
            .addOnSuccessListener { result ->
                // lines of text, grouped into the rows they sit on (tables come out a row per line, cells left to right)
                val lines = result.textBlocks.flatMap { it.lines }.filter { it.boundingBox != null }
                val sorted = lines.sortedBy { it.boundingBox!!.centerY() }
                val rows = mutableListOf<MutableList<com.google.mlkit.vision.text.Text.Line>>()
                for (l in sorted) {
                    val b = l.boundingBox!!
                    val row = rows.lastOrNull()
                    val rb = row?.firstOrNull()?.boundingBox
                    if (row != null && rb != null && Math.abs(rb.centerY() - b.centerY()) < Math.max(b.height(), rb.height()) * 0.6) row.add(l) else rows.add(mutableListOf(l))
                }
                val text = rows.joinToString("\n") { r -> r.sortedBy { it.boundingBox!!.left }.joinToString("   ") { it.text } }
                call.resolve(JSObject().put("text", if (text.isNotBlank()) text else result.text))
            }
            .addOnFailureListener { e -> call.reject(why(e)) }
    }

    /** a data URL or plain base64 image -> bitmap, at most 2048 px on the longest side */
    private fun decode(s: String): Bitmap? = try {
        val b64 = s.substringAfter("base64,", s)
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        if (bmp == null) null else {
            val scale = 2048.0 / maxOf(bmp.width, bmp.height)
            if (scale < 1.0) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
        }
    } catch (e: Throwable) { null }
}
