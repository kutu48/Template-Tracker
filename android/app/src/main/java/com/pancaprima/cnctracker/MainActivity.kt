package com.pancaprima.cnctracker

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebChromeClient
import com.google.zxing.integration.android.IntentIntegrator
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class MainActivity : BridgeActivity() {

    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCameraUri: Uri? = null
    // Simpan referensi kuat ke WebView cetak agar tidak di-GC sebelum PrintManager selesai
    private var activePrintWebView: WebView? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = pendingFileCallback
        pendingFileCallback = null
        if (callback == null) return@registerForActivityResult

        var uris: Array<Uri>? = null
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val clipData = data?.clipData
            if (clipData != null && clipData.itemCount > 0) {
                uris = Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
            } else if (data?.data != null) {
                uris = arrayOf(data.data!!)
            } else if (pendingCameraUri != null) {
                uris = arrayOf(pendingCameraUri!!)
            }
        }
        pendingCameraUri = null
        callback.onReceiveValue(uris)
    }

    private val qrScanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val scan = IntentIntegrator.parseActivityResult(
            IntentIntegrator.REQUEST_CODE,
            result.resultCode,
            result.data
        )
        val contents = scan?.contents ?: return@registerForActivityResult
        val quoted = JSONObject.quote(contents)
        bridge?.webView?.post {
            bridge?.webView?.evaluateJavascript(
                "if(window.onNativeQrScanned){window.onNativeQrScanned($quoted);}else if(window.onNativeBarcodeResult){window.onNativeBarcodeResult($quoted);}",
                null
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val capBridge = bridge ?: return
        val webView = capBridge.webView ?: return

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowContentAccess = true
        }
        webView.addJavascriptInterface(AndroidBridge(), "Android")

        // File chooser lengkap (Kamera + Galeri + File JSON backup)
        webView.webChromeClient = object : BridgeWebChromeClient(capBridge) {
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback
                pendingCameraUri = null

                val acceptTypes = fileChooserParams?.acceptTypes?.filter { it.isNotBlank() } ?: emptyList()
                val wantsImage = acceptTypes.isEmpty() || acceptTypes.any { it.startsWith("image/") || it.contains("image") }

                val contentIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (acceptTypes.size == 1 && acceptTypes[0].contains("/")) acceptTypes[0] else "*/*"
                    if (wantsImage && acceptTypes.all { it.startsWith("image/") }) {
                        type = "image/*"
                    }
                }

                val extraIntents = mutableListOf<Intent>()
                if (wantsImage) {
                    try {
                        val photoFile = File.createTempFile("sketch_capture_", ".jpg", cacheDir)
                        val photoUri = FileProvider.getUriForFile(
                            this@MainActivity,
                            "${applicationContext.packageName}.fileprovider",
                            photoFile
                        )
                        pendingCameraUri = photoUri
                        val captureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                            putExtra(MediaStore.EXTRA_OUTPUT, photoUri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                        }
                        extraIntents.add(captureIntent)
                    } catch (_: Exception) {
                        pendingCameraUri = null
                    }
                }

                val chooser = Intent.createChooser(contentIntent, if (wantsImage) "Pilih Foto / Kamera" else "Pilih File")
                if (extraIntents.isNotEmpty()) {
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extraIntents.toTypedArray())
                }

                return try {
                    fileChooserLauncher.launch(chooser)
                    true
                } catch (_: Exception) {
                    pendingFileCallback?.onReceiveValue(null)
                    pendingFileCallback = null
                    pendingCameraUri = null
                    false
                }
            }
        }
    }

    private fun buildPrintAttributes(paperType: String): PrintAttributes {
        val builder = PrintAttributes.Builder()
            .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
        when (paperType.trim().uppercase()) {
            "58" -> builder.setMediaSize(
                PrintAttributes.MediaSize("THERMAL_58MM", "Thermal 58mm", 2283, 11811)
            )
            "80" -> builder.setMediaSize(
                PrintAttributes.MediaSize("THERMAL_80MM", "Thermal 80mm", 3150, 11811)
            )
            else -> builder.setMediaSize(PrintAttributes.MediaSize.ISO_A4)
        }
        return builder.build()
    }

    private fun sketchDir(): File {
        val dir = File(filesDir, "sketches")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun safeId(raw: String): String {
        return raw.replace(Regex("[^A-Za-z0-9._-]"), "_")
    }

    inner class AndroidBridge {

        @JavascriptInterface
        fun scanQr() {
            runOnUiThread {
                val intent = IntentIntegrator(this@MainActivity)
                    .setPrompt("Scan QR Storage / Template")
                    .setBeepEnabled(true)
                    .setOrientationLocked(false)
                    .createScanIntent()
                qrScanLauncher.launch(intent)
            }
        }

        @JavascriptInterface
        fun scanBarcode(callbackName: String?) {
            scanQr()
        }

        /**
         * Cetak dokumen HTML bersih menggunakan WebView khusus cetak + PrintAttributes.
         * Mengatasi bug WebView Android di mana window.print() tidak berjalan dan elemen <canvas> QR tercetak kosong.
         */
        @JavascriptInterface
        fun printHtml(htmlContent: String, jobName: String?, paperType: String?) {
            runOnUiThread {
                try {
                    val safeJob = (jobName ?: "CNC Template Tracker").trim().ifEmpty { "CNC Template Tracker" }
                    val safePaper = (paperType ?: "A4").trim()
                    val printWebView = WebView(this@MainActivity)
                    printWebView.settings.apply {
                        javaScriptEnabled = false
                        allowFileAccess = false
                        allowContentAccess = false
                    }
                    printWebView.webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView, url: String?) {
                            try {
                                val pm = getSystemService(PRINT_SERVICE) as PrintManager
                                val adapter = view.createPrintDocumentAdapter(safeJob)
                                val attrs = buildPrintAttributes(safePaper)
                                pm.print(safeJob, adapter, attrs)
                            } catch (e: Exception) {
                                Toast.makeText(this@MainActivity, "Gagal membuka dialog print: ${e.message}", Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                    activePrintWebView = printWebView
                    printWebView.loadDataWithBaseURL("https://localhost/", htmlContent, "text/html", "UTF-8", null)
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "Print gagal: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }

        @JavascriptInterface
        fun printCurrentPage() {
            runOnUiThread {
                try {
                    val webView = bridge?.webView ?: return@runOnUiThread
                    val pm = getSystemService(PRINT_SERVICE) as PrintManager
                    pm.print(
                        "CNC Template Tracker",
                        webView.createPrintDocumentAdapter("CNC Template Tracker"),
                        buildPrintAttributes("A4")
                    )
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "Print gagal: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }

        @JavascriptInterface
        fun printQRToPdf() {
            printCurrentPage()
        }

        @JavascriptInterface
        fun shareQRText(text: String) {
            runOnUiThread {
                try {
                    val shareIntent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_SUBJECT, "CNC Template Tracker - QR Storage")
                        putExtra(Intent.EXTRA_TEXT, text)
                    }
                    startActivity(Intent.createChooser(shareIntent, "Bagikan QR Storage"))
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, "Gagal membuka menu berbagi", Toast.LENGTH_SHORT).show()
                }
            }
        }

        @JavascriptInterface
        fun saveBase64File(name: String, data: String, mime: String) {
            try {
                val bytes = Base64.decode(data, Base64.DEFAULT)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val cv = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, name)
                        put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv)!!
                    contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
                    cv.clear()
                    cv.put(MediaStore.Downloads.IS_PENDING, 0)
                    contentResolver.update(uri, cv, null, null)
                } else {
                    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    dir.mkdirs()
                    FileOutputStream(File(dir, name)).use { it.write(bytes) }
                }
                runOnUiThread { Toast.makeText(this@MainActivity, "Tersimpan di Downloads: $name", Toast.LENGTH_LONG).show() }
            } catch (_: Exception) {
                runOnUiThread { Toast.makeText(this@MainActivity, "Gagal menyimpan file", Toast.LENGTH_LONG).show() }
            }
        }

        @JavascriptInterface
        fun saveSketchFile(templateId: String, idx: Int, dataUrl: String): Boolean {
            return try {
                val match = Regex("^data:(image/[A-Za-z0-9.+-]+);base64,(.+)$", RegexOption.DOT_MATCHES_ALL)
                    .find(dataUrl.trim()) ?: return false
                val mime = match.groupValues[1]
                val b64 = match.groupValues[2]
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                if (bytes.size > 1024 * 1024) return false

                val safe = safeId(templateId)
                val imgFile = File(sketchDir(), "sketch_${safe}_${idx}.bin")
                val metaFile = File(sketchDir(), "sketch_${safe}_${idx}.mime")
                imgFile.writeBytes(bytes)
                metaFile.writeText(mime)
                true
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun readSketchFile(templateId: String, idx: Int): String {
            return try {
                val safe = safeId(templateId)
                val imgFile = File(sketchDir(), "sketch_${safe}_${idx}.bin")
                if (!imgFile.exists()) return ""
                val metaFile = File(sketchDir(), "sketch_${safe}_${idx}.mime")
                val mime = if (metaFile.exists()) metaFile.readText().trim().ifEmpty { "image/jpeg" } else "image/jpeg"
                val b64 = Base64.encodeToString(imgFile.readBytes(), Base64.NO_WRAP)
                "data:$mime;base64,$b64"
            } catch (_: Exception) {
                ""
            }
        }

        @JavascriptInterface
        fun deleteSketchFiles(templateId: String): Boolean {
            return try {
                val prefix = "sketch_${safeId(templateId)}_"
                sketchDir().listFiles()?.forEach { f ->
                    if (f.name.startsWith(prefix)) f.delete()
                }
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
