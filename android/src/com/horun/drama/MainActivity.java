package com.horun.drama;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
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
    private FrameLayout root;
    private FrameLayout fullscreenBox;
    private View splashBox;
    private View splashBottom;
    private View errorBox;
    private TextView errorTitle;
    private TextView errorText;
    private Button retryBtn;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private WebChromeClient chromeClient;
    private long lastBackAt;
    /** 冷启动/深链带进来的 hash，核心就绪后直接打开 */
    private String pendingHash = DEFAULT_HOME;
    /** 当前状态栏是浅色还是深色（全屏视频退出后要恢复） */
    private boolean lightBars;
    /** 视频页/推荐页允许跟随传感器横屏；其他页面锁定竖屏 */
    private boolean orientationAuto;
    /** 播放页点“全屏横屏”后锁定横屏；退出时恢复传感器 */
    private boolean fullscreenLandscape;
    /** 横屏视频页请求了沉浸式；onResume/换肤重设系统栏时必须保持隐藏状态栏 */
    private boolean immersive;
    /** 系统栏/刘海占位（px），由 WindowInsets 动态给，适配竖屏状态栏、横屏刘海与手势条 */
    private int insetLeft;
    private int insetTop;
    private int insetRight;
    private int insetBottom;
    /** 已经写进 WebView 的 CSS 安全区数值，避免每次 inset 回调都重复 eval */
    private int cssInsetLeft = Integer.MIN_VALUE;
    private int cssInsetTop = Integer.MIN_VALUE;
    private int cssInsetRight = Integer.MIN_VALUE;
    private int cssInsetBottom = Integer.MIN_VALUE;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 官方 SplashActivity 是 activity-alias + 闪屏主题；这里在窗口 attach 前切回 AppTheme
        setTheme(R.style.AppTheme);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        root = findViewById(R.id.root);
        fullscreenBox = findViewById(R.id.fullscreen);
        splashBox = findViewById(R.id.splashBox);
        splashBottom = findViewById(R.id.splashBottom);
        errorBox = findViewById(R.id.errorBox);
        errorTitle = findViewById(R.id.errorTitle);
        errorText = findViewById(R.id.errorText);
        retryBtn = findViewById(R.id.retryBtn);
        retryBtn.setOnClickListener(v -> boot());
        setupWindowInsets();
        requestSmoothRefresh();

        String deepHash = routeFromUri(getIntent() == null ? null : getIntent().getData());
        if (deepHash != null) {
            pendingHash = deepHash;
        } else {
            // 进程被系统回收/旋转重建后，不要让 WebView 重新从推荐流开始：
            // 网页每次路由变化都会通过 HorunAndroid.setLastHash 写进这里。
            String saved = getSharedPreferences("horun", MODE_PRIVATE).getString("lastHash", DEFAULT_HOME);
            if (saved != null && saved.startsWith("/#/")) pendingHash = saved;
        }

        setupWebView();
        boot();
    }

    /** 拉起手机内核心；已经就绪就直接进首页。 */
    private void boot() {
        showSplash();
        NodeCore.start(this, new NodeCore.Callback() {
            @Override
            public void onReady() {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    hideError();
                    hideSplash();
                    loadHome();
                });
            }

            @Override
            public void onError(String message) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    hideSplash();
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
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setSaveFormData(false);
        s.setNeedInitialFocus(false);
        s.setTextZoom(100);
        s.setDefaultTextEncodingName("UTF-8");
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
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
        web.getSettings().setTextZoom(getSharedPreferences("horun", MODE_PRIVATE).getInt("fontScale", 100));

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
                // 新页面的 inline 变量会重置，必须重新灌一次安全区
                cssInsetLeft = Integer.MIN_VALUE;
                cssInsetTop = Integer.MIN_VALUE;
                cssInsetRight = Integer.MIN_VALUE;
                cssInsetBottom = Integer.MIN_VALUE;
                applyContentInsets();
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
                applyOrientation();
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
                applyOrientation();
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

    /** 站内链接留在 WebView，站外链接交给系统浏览器；dragon8662:// 走站内深链。 */
    private boolean handleUrl(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (scheme.equals("dragon8662") || scheme.equals("horun")) {
            String hash = routeFromUri(uri);
            if (hash != null && web != null) web.loadUrl(NodeCore.BASE_URL + hash);
            return true;
        }
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
        String url = NodeCore.BASE_URL + pendingHash;
        String current = web.getUrl();
        if (current != null && current.equals(url)) {
            return;
        }
        web.loadUrl(url);
    }

    private void showSplash() {
        if (splashBox != null) splashBox.setVisibility(View.VISIBLE);
        if (splashBottom != null) splashBottom.setVisibility(View.VISIBLE);
        if (errorBox != null) errorBox.setVisibility(View.GONE);
        applyBars(true);
    }

    private void hideSplash() {
        if (splashBox != null) splashBox.setVisibility(View.GONE);
        if (splashBottom != null) splashBottom.setVisibility(View.GONE);
    }

    /**
     * 官方 App 的 scheme 是 dragon8662，分享链接一般带 series_id / id。
     * 只认数字 id，落到 `#/series/<id>`；带 episode_id 就落到播放页。
     */
    private String routeFromUri(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (!scheme.equals("dragon8662") && !scheme.equals("horun")) return null;

        String seriesId = firstNonEmpty(uri.getQueryParameter("series_id"),
                uri.getQueryParameter("seriesId"), uri.getQueryParameter("id"));
        if (seriesId == null) {
            for (String seg : uri.getPathSegments()) {
                if (seg.matches("\\d{6,25}")) {
                    seriesId = seg;
                    break;
                }
            }
        }
        if (seriesId == null || !seriesId.matches("\\d{6,25}")) {
            String target = uri.getQueryParameter("url");
            if (target != null && target.startsWith(NodeCore.BASE_URL)) {
                return target.substring(NodeCore.BASE_URL.length());
            }
            return DEFAULT_HOME;
        }
        String episodeId = firstNonEmpty(uri.getQueryParameter("episode_id"),
                uri.getQueryParameter("episodeId"));
        if (episodeId != null && episodeId.matches("\\d{6,25}")) {
            String no = firstNonEmpty(uri.getQueryParameter("no"), uri.getQueryParameter("episode_no"));
            if (no == null || !no.matches("\\d{1,4}")) no = "1";
            return "/#/play/" + seriesId + "/" + episodeId + "/" + no;
        }
        return "/#/series/" + seriesId;
    }

    private static String firstNonEmpty(String... values) {
        for (String v : values) {
            if (v != null && !v.isEmpty()) return v;
        }
        return null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String hash = routeFromUri(intent == null ? null : intent.getData());
        if (hash == null) return;
        pendingHash = hash;
        if (NodeCore.isReady() && web != null) web.loadUrl(NodeCore.BASE_URL + hash);
    }

    /**
     * 原生方向策略：全屏横屏 > 自动 > 竖屏。
     * 单独抽出来，onShowCustomView/onHideCustomView/桥接调用都走同一套，避免互相覆盖。
     */
    private void applyOrientation() {
        int next;
        if (fullscreenLandscape) {
            next = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        } else if (orientationAuto) {
            next = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR;
        } else {
            next = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        }
        applyCutoutMode(fullscreenLandscape);
        try {
            setRequestedOrientation(next);
        } catch (Exception ignored) {
            // 个别 ROM 会拒绝锁横屏，页面仍能跟随传感器
        }
    }

    /**
     * 全屏横屏时不要让画面铺进刘海/挖孔：部分手机 WebView 的 safe-area 在
     * LAYOUT_FULLSCREEN 下返回 0，视频左右会被切掉一截。NEVER 把窗口限制在
     * 挖孔以外的完整矩形，退出全屏再恢复 edge-to-edge。
     */
    private void applyCutoutMode(boolean fullscreen) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return;
        try {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = fullscreen
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        } catch (Exception ignored) {
            // 非挖孔屏或 ROM 不支持，保持默认
        }
    }

    /**
     * 请求 60Hz：部分高刷屏（华为/荣耀）默认把 WebView 降到 30/60 混合刷新，
     * 列表滑动和切集动画会一顿一顿。这里明确请求 60fps；系统不支持时自动忽略。
     */
    private void requestSmoothRefresh() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
        try {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.preferredRefreshRate = 60f;
            getWindow().setAttributes(lp);
        } catch (Exception ignored) {
            // 个别 ROM 不允许改刷新率，保持系统默认
        }
    }

    /**
     * 全面屏适配：窗口铺到状态栏/刘海/手势条下面，再把真实 inset 以 CSS 变量交给网页。
     *
     * 关键点：不再给原生根布局加 padding。根布局加 padding 会在透明状态栏下露出一条
     * 黑色窗口底，华为/荣耀这类“状态栏透明”的机型顶部就是一整条黑边。改成网页自己
     * 按 --m-safe-top 排版：推荐流/播放页继续全屏铺到状态栏后面，首页/设置页把顶栏
     * 下移，但状态栏区域显示页面背景而不是黑色。
     */
    private void setupWindowInsets() {
        if (root == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout());
                insetLeft = bars.left;
                insetTop = bars.top;
                insetRight = bars.right;
                insetBottom = bars.bottom;
            } else {
                insetLeft = insets.getSystemWindowInsetLeft();
                insetTop = insets.getSystemWindowInsetTop();
                insetRight = insets.getSystemWindowInsetRight();
                insetBottom = insets.getSystemWindowInsetBottom();
            }
            applyContentInsets();
            return insets;
        });
        root.requestApplyInsets();
    }

    /** 把 px 换算成 WebView 的 CSS px，写进 --m-safe-*；网页按这些变量排版。 */
    private void applyContentInsets() {
        if (root == null) return;
        // 根布局永远不再加 padding，否则透明状态栏/手势区会出现黑底
        if (root.getPaddingLeft() != 0 || root.getPaddingTop() != 0
                || root.getPaddingRight() != 0 || root.getPaddingBottom() != 0) {
            root.setPadding(0, 0, 0, 0);
        }
        if (web == null) return;

        int left = immersive ? 0 : insetLeft;
        int top = immersive ? 0 : insetTop;
        int right = immersive ? 0 : insetRight;
        int bottom = immersive ? 0 : insetBottom;
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        int cssLeft = Math.round(left / density);
        int cssTop = Math.round(top / density);
        int cssRight = Math.round(right / density);
        int cssBottom = Math.round(bottom / density);
        if (cssLeft == cssInsetLeft && cssTop == cssInsetTop
                && cssRight == cssInsetRight && cssBottom == cssInsetBottom) {
            return;
        }
        cssInsetLeft = cssLeft;
        cssInsetTop = cssTop;
        cssInsetRight = cssRight;
        cssInsetBottom = cssBottom;

        String js = "(function(){var d=document.documentElement;if(!d)return;var s=d.style;"
                + "s.setProperty('--m-safe-top','" + cssTop + "px');"
                + "s.setProperty('--m-safe-bottom','" + cssBottom + "px');"
                + "s.setProperty('--m-safe-left','" + cssLeft + "px');"
                + "s.setProperty('--m-safe-right','" + cssRight + "px');"
                + "s.setProperty('--safe-top','" + cssTop + "px');"
                + "s.setProperty('--safe-bottom','" + cssBottom + "px');"
                + "s.setProperty('--safe-left','" + cssLeft + "px');"
                + "s.setProperty('--safe-right','" + cssRight + "px');"
                + "})();";
        web.evaluateJavascript(js, null);
    }


    /** 浅色/深色两种系统栏，官方剧场/我的用白底黑字，推荐/播放用黑底白字。 */
    private void applyBars(boolean light) {
        lightBars = light;
        if (customView != null) return;
        if (immersive) {
            hideSystemUi();
            return;
        }
        // 状态栏/导航栏都透明：内容直接铺到屏幕边缘，通知栏区域显示页面自己的背景。
        // 不能设白/黑实色，否则华为 Pura 这类透明通知栏会被盖成一条黑带。
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarDividerColor(Color.TRANSPARENT);
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        if (root != null) {
            root.setBackgroundColor(light ? 0xFFFDF8F3 : 0xFF0A0908);
        }
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(light ? mask : 0, mask);
                // 状态栏保留，导航栏隐藏；内容按系统栏 inset 排版，状态栏不会盖住页面
                controller.show(WindowInsets.Type.statusBars());
                controller.hide(WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            applyContentInsets();
            if (root != null) root.requestApplyInsets();
            return;
        }
        int flags = decor.getSystemUiVisibility();
        flags |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        if (light) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        } else {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (light) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            } else {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        decor.setSystemUiVisibility(flags);
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
        applyBars(false);
    }

    private void hideError() {
        errorBox.setVisibility(View.GONE);
        retryBtn.setEnabled(true);
    }

    private void hideSystemUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        applyContentInsets();
    }

    private void showSystemUi() {
        applyBars(lightBars);
    }

    @Override
    protected void onResume() {
        super.onResume();
        UpdateManager.get(this).resumePendingInstall();
        if (web == null) return;
        applyBars(lightBars);
        if (NodeCore.isReady()) {
            hideError();
            // 只补"还没加载过页面"的情况；从桌面切回来时 WebView 里的 hash/播放进度
            // 必须原样保留，不能每次 onResume 都 loadHome 把人重置回推荐流。
            String current = web.getUrl();
            if (current == null || current.isEmpty() || current.startsWith("about:")) loadHome();
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

        /** 系统栏配色：剧场/我的 light，推荐/播放 dark。 */
        @JavascriptInterface
        public void setBars(String mode) {
            boolean light = "light".equals(mode);
            runOnUiThread(() -> applyBars(light));
        }

        /**
         * 横屏适配：视频页传 auto 跟随传感器，播放页“全屏横屏”传 landscape 锁横屏，
         * 离开视频页或退出全屏传 portrait/auto。只由网页按路由调用。
         */
        @JavascriptInterface
        public void setOrientation(String mode) {
            final String safe = mode == null ? "portrait" : mode;
            runOnUiThread(() -> {
                fullscreenLandscape = "landscape".equals(safe);
                orientationAuto = "auto".equals(safe);
                if (fullscreenLandscape) {
                    immersive = true;
                    hideSystemUi();
                }
                applyOrientation();
            });
        }

        /** 播放页“全屏横屏”按钮：进入锁横屏 + 隐藏系统栏；退出恢复传感器。 */
        @JavascriptInterface
        public void setFullscreenLandscape(boolean on) {
            runOnUiThread(() -> {
                fullscreenLandscape = on;
                orientationAuto = !on;
                immersive = on;
                applyOrientation();
                if (on) hideSystemUi();
                else showSystemUi();
            });
        }

        /** 记住最后停留的页面，进程被回收/旋转重建后由原生带回同一个 hash。 */
        @JavascriptInterface
        public void setLastHash(String hash) {
            if (hash == null || !hash.startsWith("/#/")) return;
            pendingHash = hash;
            getSharedPreferences("horun", MODE_PRIVATE).edit().putString("lastHash", hash).apply();
        }

        /** 横屏播放时隐藏状态栏/导航栏；回到竖屏或离开播放器时恢复。 */
        @JavascriptInterface
        public void setImmersive(boolean on) {
            immersive = on;
            runOnUiThread(() -> {
                if (customView != null) return;
                if (on) hideSystemUi();
                else showSystemUi();
            });
        }

        /** 系统字号缩放（WebView textZoom），90~125，立即生效并持久化。 */
        @JavascriptInterface
        public void setFontScale(int percent) {
            final int safe = Math.max(80, Math.min(150, percent));
            runOnUiThread(() -> {
                if (web == null) return;
                web.getSettings().setTextZoom(safe);
                getSharedPreferences("horun", MODE_PRIVATE).edit().putInt("fontScale", safe).apply();
            });
        }

        /** 多线程 Range 分段下载 APK；URL 由网页从 GitHub release 里取。 */
        @JavascriptInterface
        public void downloadUpdate(String url, String fileName, String sha256, int threads, double expectedSize) {
            runOnUiThread(() -> UpdateManager.get(MainActivity.this).start(url, fileName, sha256, threads, (long) expectedSize));
        }

        @JavascriptInterface
        public String getUpdateState() {
            return UpdateManager.get(MainActivity.this).getState();
        }

        @JavascriptInterface
        public String getUpdateProgress() {
            return UpdateManager.get(MainActivity.this).getProgressJson();
        }

        @JavascriptInterface
        public void installUpdate() {
            runOnUiThread(() -> UpdateManager.get(MainActivity.this).install());
        }
    }
}
