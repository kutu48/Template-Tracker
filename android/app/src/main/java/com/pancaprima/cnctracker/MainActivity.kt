package com.pancaprima.cnctracker

import android.app.*
import android.content.*
import android.net.*
import android.os.*
import android.provider.MediaStore
import android.util.Base64
import android.webkit.*
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.zxing.integration.android.IntentIntegrator

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    override fun onCreate(state: Bundle?) { super.onCreate(state)
        web = WebView(this); setContentView(web)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        with(web.settings) { javaScriptEnabled=true; domStorageEnabled=true; databaseEnabled=true; cacheMode=WebSettings.LOAD_DEFAULT; allowFileAccess=false; mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW }
        web.addJavascriptInterface(Bridge(), "Android")
        web.webViewClient=object:WebViewClient(){ override fun onPageFinished(v:WebView,u:String){ v.evaluateJavascript("window.print=()=>Android.printCurrentPage()",null) } }
        web.webChromeClient=WebChromeClient()
        web.setDownloadListener { url,_,disposition,mime,_ -> if(url.startsWith("http")){ val req=DownloadManager.Request(Uri.parse(url)); req.setMimeType(mime); req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED); req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url,disposition,mime)); (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req) } }
        if(state==null) web.loadUrl(BuildConfig.APP_URL) else web.restoreState(state)
    }
    override fun onSaveInstanceState(out:Bundle){ web.saveState(out); super.onSaveInstanceState(out) }
    override fun onBackPressed(){ if(web.canGoBack()) web.goBack() else super.onBackPressed() }
    override fun onActivityResult(request:Int,result:Int,data:Intent?){ val scan=IntentIntegrator.parseActivityResult(request,result,data); if(scan?.contents!=null){ web.evaluateJavascript("window.onNativeQrScanned(${org.json.JSONObject.quote(scan.contents)})",null); return }; super.onActivityResult(request,result,data) }
    inner class Bridge {
        @JavascriptInterface fun scanQr(){ runOnUiThread { IntentIntegrator(this@MainActivity).setPrompt("Scan QR Storage").setBeepEnabled(true).setOrientationLocked(false).initiateScan() } }
        @JavascriptInterface fun printCurrentPage(){ runOnUiThread { val pm=getSystemService(PRINT_SERVICE) as android.print.PrintManager; pm.print("CNC Tracker",web.createPrintDocumentAdapter("CNC Tracker"),null) } }
        @JavascriptInterface fun saveBase64File(name:String,data:String,mime:String){ try { val bytes=Base64.decode(data,Base64.DEFAULT); val cv=android.content.ContentValues().apply{ put(MediaStore.Downloads.DISPLAY_NAME,name); put(MediaStore.Downloads.MIME_TYPE,mime); put(MediaStore.Downloads.IS_PENDING,1) }; if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) { val uri=contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,cv)!!; contentResolver.openOutputStream(uri)!!.use{it.write(bytes)}; cv.clear();cv.put(MediaStore.Downloads.IS_PENDING,0);contentResolver.update(uri,cv,null,null) } else { val dir=android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS); dir.mkdirs(); java.io.FileOutputStream(java.io.File(dir,name)).use{it.write(bytes)} } runOnUiThread{Toast.makeText(this@MainActivity,"Tersimpan di Downloads",Toast.LENGTH_LONG).show()} }catch(e:Exception){runOnUiThread{Toast.makeText(this@MainActivity,"Download gagal",Toast.LENGTH_LONG).show()}} }
    }
}
