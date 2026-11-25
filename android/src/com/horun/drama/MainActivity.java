package com.horun.drama;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 独立版外壳：不连电脑，启动 APK 内置的 Node 核心，再用 WebView 打开 127.0.0.1:5881。
 *
 * 保留的能力：返回键、全屏视频、文件下载、本地核心日志。
 * 不做的事：不需要电脑、不需要 hgsigner.exe、不向局域网暴露服务。
 */
public class MainActivity extends Activity {

    private static final String DEFAULT_HOME = "/#/feed";

    private WebView web;
    private FrameLayout fullscreenBox;
    private View errorBox;
    private TextView errorTitle;
    private TextView errorText;
    private Button retryBtn;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private WebChromeClient chromeClient;
    private long lastBackAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        fullscreenBox = findViewById(R.id.fullscreen);
        errorBox = findViewById(R.id.errorBox);
        errorTitle = findViewById(R.id.errorTitle);
        errorText = findViewById(R.id.errorText);
        retryBtn = findViewById(R.id.retryBtn);
        retryBtn.setOnClickListener(v -> boot());

        setupWebView();
        boot();
    }

    /** 拉起手机内核心；已经就绪就直接进首页。 */
    private void boot() {
        showBooting();
        NodeCore.start(this, new NodeCore.Callback() {
            @Override
            public void onReady() {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    hideError();
                    loadHome();
                });
            }

            @Override
            public void onError(String message) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    showError(message);
                });
            }
        });
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            s.setForceDark(WebSettings.FORCE_DARK_OFF);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        }

        web.setBackgroundColor(0xFF0A0908);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.addJavascriptInterface(new Bridge(), "HorunAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && NodeCore.isReady()) {
                    showError("页面加载失败：" + error.getDescription());
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (NodeCore.isReady()) hideError();
            }
        });

        chromeClient = new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                fullscreenBox.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                fullscreenBox.setVisibility(View.VISIBLE);
                web.setVisibility(View.GONE);
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR);
                hideSystemUi();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                fullscreenBox.removeAllViews();
                fullscreenBox.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                customView = null;
                if (customViewCallback != null) customViewCallback.onCustomViewHidden();
                customViewCallback = null;
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                showSystemUi();
            }
        };
        web.setWebChromeClient(chromeClient);

        // 下载：交给系统下载器，落到手机的「下载」目录（本地核心 /api/media 提供整集 mp4）
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                try {
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setMimeType(mimeType);
                    req.addRequestHeader("User-Agent", userAgent);
                    String name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
                    req.setTitle(name);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "HorunDrama/" + name);
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) {
                        dm.enqueue(req);
                        Toast.makeText(MainActivity.this, "已开始下载到手机「下载/HorunDrama」", Toast.LENGTH_LONG).show();
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        });
    }

    /** 站内链接留在 WebView，站外链接交给系统浏览器。 */
    private boolean handleUrl(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (!scheme.startsWith("http")) return true;
        String authority = uri.getAuthority() == null ? "" : uri.getAuthority();
        if (authority.equalsIgnoreCase(NodeCore.HOST + ":" + NodeCore.PORT)
                || authority.equalsIgnoreCase("localhost:" + NodeCore.PORT)
                || authority.equalsIgnoreCase(NodeCore.HOST)) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            Toast.makeText(this, "没有可打开该链接的应用", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void loadHome() {
        String url = NodeCore.BASE_URL + DEFAULT_HOME;
        String current = web.getUrl();
        if (current != null && current.startsWith(NodeCore.BASE_URL)) {
            return;
        }
        web.loadUrl(url);
    }

    private void showBooting() {
        errorTitle.setText("正在启动本地核心…");
        errorText.setText("首次启动会释放内置运行组件，大约需要 5–15 秒。\n\n之后每次打开都直接进入，不再依赖电脑。");
        retryBtn.setEnabled(false);
        errorBox.setVisibility(View.VISIBLE);
    }

    private void showError(String message) {
        errorTitle.setText("本地核心没有起来");
        String logs = NodeCore.lastLogs().trim();
        if (logs.length() > 1200) logs = logs.substring(logs.length() - 1200);
        errorText.setText(message
                + "\n\n可先点「重新启动」。如果一直失败，把下面的日志反馈给开发者。"
                + (logs.isEmpty() ? "" : "\n\n" + logs));
        retryBtn.setEnabled(true);
        errorBox.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        errorBox.setVisibility(View.GONE);
        retryBtn.setEnabled(true);
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private void showSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null) return;
        if (NodeCore.isReady()) {
            hideError();
            loadHome();
        }
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            if (chromeClient != null) chromeClient.onHideCustomView();
            return;
        }
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            super.onBackPressed();
        } else {
            lastBackAt = now;
            Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        if (isFinishing()) NodeCore.stop(this);
        super.onDestroy();
    }

    /** 网页桥：保留旧接口，独立版地址固定为本机，不再读写电脑地址。 */
    private class Bridge {
        @JavascriptInterface
        public String getServerUrl() {
            return NodeCore.BASE_URL;
        }

        @JavascriptInterface
        public void setServerUrl(String url) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    "独立版核心在手机内，地址固定为 " + NodeCore.BASE_URL, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void openSetup() {
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    "独立版不需要设置电脑地址", Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }
    }
}
