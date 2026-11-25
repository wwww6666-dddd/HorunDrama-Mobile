package com.horun.drama;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

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
import java.util.List;
import java.util.Locale;
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

    public void start(String url, String fileName, String sha256, int threads) {
        if ("downloading".equals(state)) {
            toast("更新已经在下载中");
            return;
        }
        final int workers = Math.max(1, Math.min(8, threads <= 0 ? THREADS : threads));
        final String safeName = fileName == null || fileName.trim().isEmpty()
                ? "HorunDrama-update.apk"
                : fileName.replaceAll("[^A-Za-z0-9._-]", "_");
        state = "downloading";
        new Thread(() -> download(url, safeName, sha256, workers), "apk-update").start();
    }

    private void download(String url, String fileName, String sha256, int workers) {
        File dir = new File(activity.getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) {
            fail("无法创建更新目录");
            return;
        }
        File output = new File(dir, fileName);
        List<File> parts = new ArrayList<>();
        try {
            long total = contentLength(url);
            if (total <= 0) {
                // 有些 CDN 不返回长度：退回单连接
                downloadSingle(url, output);
                finishDownload(output, sha256);
                return;
            }
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
                        downloadRange(url, part, start, end, received, total);
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
            if (errors[0] != null) throw errors[0];
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
            finishDownload(output, sha256);
        } catch (Exception e) {
            fail(e.getMessage() == null ? e.toString() : e.getMessage());
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
            int code = conn.getResponseCode();
            if (code != 206 && code != 200) throw new IOExceptionWithCode(code);
            long expected = end - start + 1;
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[32 * 1024];
                long written = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    written += n;
                    received.addAndGet(n);
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
            if (conn.getResponseCode() != 200) throw new IOExceptionWithCode(conn.getResponseCode());
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 FileOutputStream out = new FileOutputStream(output)) {
                byte[] buf = new byte[32 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        } finally {
            conn.disconnect();
        }
    }

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(30_000);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", "HorunDrama-Android-Updater");
        conn.setRequestProperty("Accept", "application/octet-stream");
        return conn;
    }

    private void finishDownload(File output, String expectedSha) throws Exception {
        String actual = sha256(output);
        if (expectedSha != null && expectedSha.startsWith("sha256:")) expectedSha = expectedSha.substring(7);
        if (expectedSha != null && expectedSha.length() == 64
                && !actual.equalsIgnoreCase(expectedSha.trim())) {
            //noinspection ResultOfMethodCallIgnored
            output.delete();
            throw new Exception("SHA-256 校验失败，更新包可能不完整");
        }
        downloadedPath = output.getAbsolutePath();
        state = "downloaded";
        main.post(() -> {
            toast("更新包下载完成，正在打开安装界面");
            install();
        });
    }

    private void fail(String message) {
        state = "failed:" + message;
        main.post(() -> toast("更新下载失败：" + message));
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
