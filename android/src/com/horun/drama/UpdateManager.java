package com.horun.drama;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * APK 自动更新：四线程 Range 分段下载 + 合并 + SHA-256 校验 + 系统安装器。
 *
 * 说明：Android 不允许普通应用静默安装；下载完成后会拉起系统安装界面，
 * Android 8+ 首次需要在系统设置里允许「安装未知应用」。
 */
public final class UpdateManager {
    private static final int THREADS = 4;
    private static UpdateManager instance;

    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile String state = "idle";
    private volatile String downloadedPath = "";
    private volatile boolean pendingInstall = false;
    private volatile long receivedBytes = 0;
    private volatile long totalBytes = 0;
    private volatile long expectedSizeBytes = 0;
    private volatile String message = "";
    private volatile int sourceIndex = 0;
    private volatile int sourceCount = 0;

    private UpdateManager(Activity activity) {
        this.activity = activity;
    }

    public static synchronized UpdateManager get(Activity activity) {
        if (instance == null || instance.activity != activity) {
            instance = new UpdateManager(activity);
        }
        return instance;
    }

    public String getState() {
        return state;
    }

    /**
     * 给网页轮询更新进度。PC 端用 IPC 实时推，Android WebView 这边用轻量轮询更稳；
     * 字段与 PC 的 progress 对齐：received/total/percent/mode/message。
     */
    public String getProgressJson() {
        try {
            JSONObject json = new JSONObject();
            json.put("state", state);
            json.put("received", receivedBytes);
            json.put("total", totalBytes > 0 ? totalBytes : expectedSizeBytes);
            json.put("percent", totalBytes > 0 ? Math.min(1.0, (double) receivedBytes / (double) totalBytes) : 0.0);
            json.put("message", message);
            json.put("path", downloadedPath);
            json.put("sourceIndex", sourceIndex);
            json.put("sourceCount", sourceCount);
            return json.toString();
        } catch (Exception e) {
            return "{\"state\":\"idle\",\"percent\":0}";
        }
    }

    /**
     * 更新下载支持多源：网页把 GitHub 原始地址 + 镜像地址用 `|` 拼起来。
     * 直连 GitHub 超时就自动换下一个镜像，不需要用户手动重试。
     */
    public void start(String url, String fileName, String sha256, int threads, long expectedSize) {
        if ("downloading".equals(state)) {
            toast("更新已经在下载中");
            return;
        }
        final int workers = Math.max(1, Math.min(8, threads <= 0 ? THREADS : threads));
        final String safeName = fileName == null || fileName.trim().isEmpty()
                ? "HorunDrama-update.apk"
                : fileName.replaceAll("[^A-Za-z0-9._-]", "_");
        if (!safeName.toLowerCase(Locale.US).matches("horundrama-mobile-\\d+\\.\\d+\\.\\d+-standalone\\.apk")) {
            fail("更新包文件名不合法");
            return;
        }
        final String expectedSha = sha256 == null ? "" : sha256.replaceFirst("(?i)^sha256:", "").trim().toLowerCase(Locale.US);
        if (!expectedSha.matches("[a-f0-9]{64}")) {
            fail("更新包缺少有效的 SHA-256，无法校验");
            return;
        }
        final List<String> sources = new ArrayList<>();
        if (url != null) {
            for (String item : url.split("\\|")) {
                String trimmed = item.trim();
                if (!trimmed.isEmpty() && isAllowedUpdateSource(trimmed)) sources.add(trimmed);
            }
        }
        if (sources.isEmpty()) {
            fail("更新地址为空或不是项目 Release");
            return;
        }
        expectedSizeBytes = expectedSize > 0 ? expectedSize : 0;
        totalBytes = expectedSizeBytes;
        receivedBytes = 0;
        message = "准备下载更新";
        sourceIndex = 0;
        sourceCount = sources.size();
        downloadedPath = "";

        // 上次已经下完、校验也通过：直接复用，避免安装被取消后整包重下。
        File dir = new File(activity.getCacheDir(), "updates");
        File output = new File(dir, safeName);
        if (output.exists() && verifyFile(output, expectedSha, expectedSizeBytes)) {
            downloadedPath = output.getAbsolutePath();
            state = "downloaded";
            receivedBytes = output.length();
            totalBytes = output.length();
            message = "更新包已存在且校验通过";
            main.post(() -> {
                toast("更新包已下载完成，正在打开安装界面");
                install();
            });
            return;
        }

        state = "downloading";
        final long finalSize = expectedSizeBytes;
        new Thread(() -> downloadSources(sources, safeName, expectedSha, workers, finalSize), "apk-update").start();
    }

    private void downloadSources(List<String> sources, String fileName, String sha256, int workers, long expectedSize) {
        Exception last = null;
        for (int i = 0; i < sources.size(); i++) {
            String source = sources.get(i);
            sourceIndex = i;
            message = "正在从下载线路 " + (i + 1) + "/" + sources.size() + " 下载";
            receivedBytes = 0;
            try {
                download(source, fileName, sha256, workers, expectedSize);
                return;
            } catch (Exception e) {
                last = e;
                // 切镜像前清掉半成品，避免下一次 Range 写进旧文件
                File stale = new File(new File(activity.getCacheDir(), "updates"), fileName);
                //noinspection ResultOfMethodCallIgnored
                stale.delete();
                for (int p = 0; p < workers; p++) {
                    //noinspection ResultOfMethodCallIgnored
                    new File(stale.getAbsolutePath() + ".part" + p).delete();
                }
                if (i + 1 < sources.size()) {
                    final String nextHint = "下载线路失败，正在切换更新镜像 " + (i + 2) + "/" + sources.size();
                    main.post(() -> toast(nextHint));
                }
            }
        }
        fail(last == null ? "所有更新线路都连不上" : (last.getMessage() == null ? last.toString() : last.getMessage()));
    }

    private void download(String url, String fileName, String sha256, int workers, long expectedSize) throws Exception {
        File dir = new File(activity.getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new Exception("无法创建更新目录");
        }
        File output = new File(dir, fileName);
        List<File> parts = new ArrayList<>();
        try {
            long total = contentLength(url);
            if (total <= 0 && expectedSize > 0) total = expectedSize;
            if (total <= 0) {
                // 有些 CDN 不返回长度：退回单连接
                downloadSingle(url, output);
                finishDownload(output, sha256, expectedSize);
                return;
            }
            totalBytes = total;
            final long totalForPart = total;
            long chunk = (total + workers - 1) / workers;
            AtomicLong received = new AtomicLong();
            List<Thread> threads = new ArrayList<>();
            final Exception[] errors = new Exception[1];
            for (int i = 0; i < workers; i++) {
                long start = i * chunk;
                long end = Math.min(total - 1, start + chunk - 1);
                if (start > end) continue;
                final int index = i;
                File part = new File(dir, fileName + ".part" + index);
                parts.add(part);
                Thread thread = new Thread(() -> {
                    try {
                        downloadRange(url, part, start, end, received, totalForPart);
                    } catch (Exception e) {
                        synchronized (errors) {
                            if (errors[0] == null) errors[0] = e;
                        }
                    }
                }, "apk-part-" + index);
                threads.add(thread);
                thread.start();
            }
            for (Thread thread : threads) thread.join();
            if (errors[0] != null) {
                // 和 PC 端一致：某些镜像/CDN 不认 Range（回 200 或断流），
                // 不要直接判更新失败，清掉分片后退回单连接再下一次。
                message = "分段下载不可用，已退回单连接";
                for (File part : parts) {
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                }
                receivedBytes = 0;
                downloadSingle(url, output);
                finishDownload(output, sha256, expectedSize);
                return;
            }
            try (RandomAccessFile target = new RandomAccessFile(output, "rw")) {
                target.setLength(total);
                for (File part : parts) {
                    try (FileInputStream in = new FileInputStream(part)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) target.write(buf, 0, n);
                    }
                }
            }
            finishDownload(output, sha256, expectedSize);
        } finally {
            for (File part : parts) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
            }
        }
    }

    private long contentLength(String url) throws Exception {
        HttpURLConnection conn = open(url);
        try {
            conn.setRequestMethod("HEAD");
            conn.connect();
            checkRedirect(conn);
            long len = conn.getContentLengthLong();
            return len > 0 ? len : 0;
        } finally {
            conn.disconnect();
        }
    }

    private void downloadRange(String url, File part, long start, long end, AtomicLong received, long total) throws Exception {
        HttpURLConnection conn = open(url);
        try {
            conn.setRequestProperty("Range", "bytes=" + start + "-" + end);
            conn.connect();
            checkRedirect(conn);
            int code = conn.getResponseCode();
            // 分段下载必须 206；某些镜像不认 Range 会回 200 整包，
            // 这时四个线程都会写第一段，合并出来是坏包。统一判失败换单连接/镜像。
            if (code != 206) throw new IOExceptionWithCode(code);
            long expected = end - start + 1;
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[32 * 1024];
                long written = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    written += n;
                    receivedBytes = received.addAndGet(n);
                }
                if (written != expected) {
                    throw new IOExceptionWithCode(-1);
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    private void downloadSingle(String url, File output) throws Exception {
        HttpURLConnection conn = open(url);
        try {
            conn.connect();
            checkRedirect(conn);
            if (conn.getResponseCode() != 200) throw new IOExceptionWithCode(conn.getResponseCode());
            long length = conn.getContentLengthLong();
            if (length > 0) totalBytes = length;
            long done = 0;
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 FileOutputStream out = new FileOutputStream(output)) {
                byte[] buf = new byte[32 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    receivedBytes = done;
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    private static boolean isAllowedUpdateSource(String raw) {
        try {
            URL url = new URL(raw);
            if (!"https".equalsIgnoreCase(url.getProtocol())) return false;
            String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.US);
            String path = url.getPath() == null ? "" : url.getPath();
            if ("github.com".equals(host)) {
                return path.matches("^/wwww6666-dddd/HorunDrama-Mobile/releases/download/v\\d+\\.\\d+\\.\\d+/[^/]+$");
            }
            if ("gh-proxy.com".equals(host) || "gh-proxy.org".equals(host) || "ghproxy.net".equals(host) || "ghfast.top".equals(host)) {
                // 镜像格式：https://gh-proxy.org/https://github.com/.../xxx.apk
                return raw.contains("https://github.com/wwww6666-dddd/HorunDrama-Mobile/releases/download/v");
            }
            if ("api.gitproxy.dev".equals(host)) {
                // gitproxy 格式：https://api.gitproxy.dev/github.com/.../xxx.apk
                return path.matches("^/github\\.com/wwww6666-dddd/HorunDrama-Mobile/releases/download/v\\d+\\.\\d+\\.\\d+/[^/]+$");
            }
            if ("github.akams.cn".equals(host) || "gh.ddlc.top".equals(host)) {
                return raw.contains("https://github.com/wwww6666-dddd/HorunDrama-Mobile/releases/download/v");
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isAllowedRedirect(URL url) {
        if (url == null || !"https".equalsIgnoreCase(url.getProtocol())) return false;
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.US);
        return "github.com".equals(host)
                || "release-assets.githubusercontent.com".equals(host)
                || "objects.githubusercontent.com".equals(host)
                || "gh-proxy.com".equals(host)
                || "gh-proxy.org".equals(host)
                || "ghproxy.net".equals(host)
                || "ghfast.top".equals(host)
                || "api.gitproxy.dev".equals(host)
                || "github.akams.cn".equals(host)
                || "gh.ddlc.top".equals(host);
    }

    private static void checkRedirect(HttpURLConnection conn) throws Exception {
        if (!isAllowedRedirect(conn.getURL())) throw new Exception("更新下载被重定向到非可信地址");
    }

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(7_000);
        conn.setReadTimeout(25_000);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", "HorunDrama-Android-Updater");
        conn.setRequestProperty("Accept", "application/octet-stream");
        return conn;
    }

    private void finishDownload(File output, String expectedSha, long expectedSize) throws Exception {
        state = "verifying";
        message = "正在校验更新包";
        if (expectedSize > 0 && Math.abs(output.length() - expectedSize) > 1024) {
            //noinspection ResultOfMethodCallIgnored
            output.delete();
            throw new Exception("更新包大小不对，已删除");
        }
        String actual = sha256(output);
        if (expectedSha == null || expectedSha.length() != 64) {
            //noinspection ResultOfMethodCallIgnored
            output.delete();
            throw new Exception("更新包缺少 SHA-256 校验值");
        }
        if (!actual.equalsIgnoreCase(expectedSha.trim())) {
            //noinspection ResultOfMethodCallIgnored
            output.delete();
            throw new Exception("SHA-256 校验失败，更新包可能不完整");
        }
        try {
            verifyApk(output);
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            output.delete();
            throw e;
        }
        downloadedPath = output.getAbsolutePath();
        state = "downloaded";
        receivedBytes = output.length();
        totalBytes = output.length();
        message = "更新包下载完成，正在打开安装界面";
        main.post(() -> {
            toast("更新包下载完成，正在打开安装界面");
            install();
        });
    }

    /** 校验文件大小与 SHA-256；用于复用缓存包，避免整包重复下载。 */
    private boolean verifyFile(File file, String expectedSha, long expectedSize) {
        try {
            if (expectedSize > 0 && Math.abs(file.length() - expectedSize) > 1024) return false;
            return sha256(file).equalsIgnoreCase(expectedSha.trim());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 安装前验包：必须是当前包名、版本不能倒退、签名必须和已安装版本一致。
     * PC 端会验 ZIP 里的可执行文件；Android 端对应的是 PackageManager + 签名。
     */
    private void verifyApk(File apk) throws Exception {
        PackageManager pm = activity.getPackageManager();
        PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        if (archive == null || archive.packageName == null || !archive.packageName.equals(activity.getPackageName())) {
            throw new Exception("下载的 APK 不是 HorunDrama 安装包");
        }
        long newCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? archive.getLongVersionCode() : archive.versionCode;
        PackageInfo current = pm.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNATURES);
        long currentCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? current.getLongVersionCode() : current.versionCode;
        if (newCode < currentCode) throw new Exception("下载的 APK 版本比当前版本低");
        if (!sameSignatures(current.signatures, archive.signatures)) {
            throw new Exception("下载的 APK 签名与当前应用不一致");
        }
    }

    private static boolean sameSignatures(Signature[] a, Signature[] b) {
        if (a == null || b == null) return false;
        Set<String> left = new HashSet<>();
        Set<String> right = new HashSet<>();
        try {
            for (Signature sig : a) left.add(certSha256(sig));
            for (Signature sig : b) right.add(certSha256(sig));
        } catch (Exception e) {
            return false;
        }
        return left.equals(right);
    }

    private static String certSha256(Signature signature) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return bytesHex(digest.digest(signature.toByteArray()));
    }

    private static String bytesHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }

    private void fail(String error) {
        state = "failed";
        message = error;
        main.post(() -> toast("更新下载失败：" + error));
    }

    public void install() {
        if (downloadedPath.isEmpty()) {
            toast("还没有下载好的更新包");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            pendingInstall = true;
            toast("请允许本应用安装未知应用，返回后会自动继续");
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivity(intent);
            } catch (Exception e) {
                toast("请到系统设置里允许安装未知应用");
            }
            return;
        }
        pendingInstall = false;
        File apk = new File(downloadedPath);
        if (!apk.exists()) {
            toast("更新包已被清理，请重新下载");
            state = "idle";
            return;
        }
        Uri uri = ApkProvider.uriFor(apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(intent);
        } catch (Exception e) {
            toast("无法打开安装器：" + e.getMessage());
        }
    }

    public void resumePendingInstall() {
        if (!pendingInstall) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || activity.getPackageManager().canRequestPackageInstalls()) {
            pendingInstall = false;
            install();
        }
    }

    private void toast(String text) {
        Toast.makeText(activity, text, Toast.LENGTH_SHORT).show();
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) digest.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : digest.digest()) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }

    private static final class IOExceptionWithCode extends java.io.IOException {
        IOExceptionWithCode(int code) {
            super("HTTP " + code);
        }
    }
}
