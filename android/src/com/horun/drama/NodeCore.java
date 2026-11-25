package com.horun.drama;

import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 手机内的核心进程：APK 自带 Node 运行时和编译后的核心，启动后由 WebView 连本机 5881。
 *
 * 不依赖电脑、不依赖 hgsigner.exe：签名在 Node 进程内完成，ffmpeg 用 APK 里的 libffmpeg.so。
 */
final class NodeCore {

    static final String HOST = "127.0.0.1";
    static final int PORT = 5881;
    static final String BASE_URL = "http://" + HOST + ":" + PORT;

    interface Callback {
        void onReady();
        void onError(String message);
    }

    private static final Object LOCK = new Object();
    private static final StringBuilder LOGS = new StringBuilder();
    private static volatile boolean starting;
    private static volatile boolean ready;
    private static Process process;

    private NodeCore() {}

    static boolean isReady() {
        return ready && processAlive();
    }

    static void start(Context ctx, Callback callback) {
        Context app = ctx.getApplicationContext();
        synchronized (LOCK) {
            if (ready && processAlive()) {
                callback.onReady();
                return;
            }
            if (starting) return;
            starting = true;
            ready = false;
        }
        Thread worker = new Thread(() -> {
            try {
                prepare(app);
                launch(app);
                waitReady(callback);
            } catch (Throwable err) {
                Log.e("HorunCore", "核心启动失败", err);
                appendLog("启动失败：" + err.getMessage());
                synchronized (LOCK) {
                    starting = false;
                    ready = false;
                }
                callback.onError(err.getMessage() == null ? err.toString() : err.getMessage());
            }
        }, "horun-core-boot");
        worker.setDaemon(true);
        worker.start();
    }

    static void stop(Context ctx) {
        synchronized (LOCK) {
            ready = false;
            starting = false;
            if (process != null) {
                process.destroy();
                process = null;
            }
        }
    }

    static String lastLogs() {
        synchronized (LOGS) {
            return LOGS.toString();
        }
    }

    /**
     * 把 assets 里的 node/core/web 释放到应用私有目录。
     * 只在首次启动或版本变化时做，避免每次启动都拷贝 50MB。
     */
    private static void prepare(Context ctx) throws IOException {
        File prefix = ctx.getNoBackupFilesDir();
        File runtime = new File(prefix, "runtime");
        File core = new File(prefix, "core");
        File web = new File(prefix, "web");
        File marker = new File(prefix, "runtime-version.txt");
        String version = BuildConfig.VERSION_NAME + "-" + BuildConfig.VERSION_CODE;
        if (marker.isFile() && version.equals(readText(marker).trim())) {
            if (new File(core, "src/index.ts").isFile()
                    && new File(web, "index.html").isFile()
                    && new File(runtime, "cacert.pem").isFile()) {
                return;
            }
        }

        long free = new StatFs(prefix.getAbsolutePath()).getAvailableBytes();
        if (free < 220L * 1024 * 1024) {
            throw new IOException("手机可用空间不足，至少需要 220MB 空余（当前 "
                    + (free / 1024 / 1024) + "MB）");
        }
        appendLog("首次启动：释放内置运行组件…");
        deleteTree(core);
        deleteTree(web);
        deleteTree(runtime);
        copyAssetTree(ctx, "core", core);
        copyAssetTree(ctx, "web", web);
        copyAssetTree(ctx, "runtime", runtime);
        File cert = new File(runtime, "cacert.pem");
        if (!cert.isFile() || cert.length() < 100_000) {
            throw new IOException("内置 CA 证书缺失，请重新安装 APK");
        }
        writeText(marker, version);
        appendLog("运行组件已释放：" + prefix.getAbsolutePath());
    }

    private static void launch(Context ctx) throws IOException {
        File prefix = ctx.getNoBackupFilesDir();
        File runtime = new File(prefix, "runtime");
        File core = new File(prefix, "core");
        File web = new File(prefix, "web");
        String nodeLib = ctx.getApplicationInfo().nativeLibraryDir + "/libnode.so";
        if (!new File(nodeLib).isFile()) {
            throw new IOException("APK 内缺少 libnode.so，请确认安装的是完整包（arm64-v8a / x86_64）");
        }
        String ffmpeg = ctx.getApplicationInfo().nativeLibraryDir + "/libffmpeg.so";

        ProcessBuilder pb = new ProcessBuilder(nodeLib, "src/index.ts", "--standalone");
        pb.directory(core);
        pb.redirectErrorStream(true);
        pb.environment().put("HORUN_HOST", HOST);
        pb.environment().put("HORUN_PORT", String.valueOf(PORT));
        pb.environment().put("HORUN_LAN", "0");
        pb.environment().put("HORUN_DATA_DIR", new File(ctx.getFilesDir(), "data").getAbsolutePath());
        pb.environment().put("HORUN_WEB_DIST", web.getAbsolutePath());
        pb.environment().put("HORUN_FFMPEG", ffmpeg);
        pb.environment().put("HORUN_LIVE_LOCAL", "1");
        File downloads = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "HorunDrama");
        if (!downloads.isDirectory() && !downloads.mkdirs()) {
            Log.w("HorunCore", "下载目录创建失败：" + downloads);
        }
        pb.environment().put("HORUN_DOWNLOAD_DIR", downloads.getAbsolutePath());
        pb.environment().put("HOME", ctx.getFilesDir().getAbsolutePath());
        pb.environment().put("TMPDIR", ctx.getCacheDir().getAbsolutePath());
        pb.environment().put("LD_LIBRARY_PATH", ctx.getApplicationInfo().nativeLibraryDir);
        pb.environment().put("SSL_CERT_FILE", new File(runtime, "cacert.pem").getAbsolutePath());
        pb.environment().put("NODE_OPTIONS", "--no-warnings");
        appendLog("启动核心：" + nodeLib);
        Process p = pb.start();
        process = p;
        Thread reader = new Thread(() -> pump(p), "horun-core-log");
        reader.setDaemon(true);
        reader.start();
        synchronized (LOCK) {
            starting = false;
            ready = false;
        }
    }

    private static void waitReady(Callback callback) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 120_000L;
        while (System.currentTimeMillis() < deadline) {
            if (!processAlive()) {
                synchronized (LOCK) {
                    ready = false;
                    starting = false;
                }
                callback.onError("核心进程退出。\n\n" + tailLogs());
                return;
            }
            if (probeHealth()) {
                synchronized (LOCK) {
                    ready = true;
                    starting = false;
                }
                Log.i("HorunCore", "本地核心已就绪：" + BASE_URL);
                callback.onReady();
                return;
            }
            Thread.sleep(350L);
        }
        synchronized (LOCK) {
            ready = false;
            starting = false;
        }
        callback.onError("本地核心启动超时（120 秒）。\n\n" + tailLogs());
    }

    private static boolean probeHealth() {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(BASE_URL + "/api/health");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(800);
            conn.setReadTimeout(800);
            conn.setUseCaches(false);
            if (conn.getResponseCode() != 200) return false;
            try (InputStream in = conn.getInputStream();
                 BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                return sb.indexOf("\"ok\":true") >= 0;
            }
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static boolean processAlive() {
        Process p = process;
        if (p == null) return false;
        try {
            p.exitValue();
            return false;
        } catch (IllegalThreadStateException alive) {
            return true;
        }
    }

    private static void pump(Process p) {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                Log.i("HorunCore", line);
                appendLog(line);
            }
        } catch (IOException err) {
            Log.w("HorunCore", "日志读取结束：" + err.getMessage());
        }
    }

    private static void appendLog(String line) {
        synchronized (LOGS) {
            LOGS.append(line).append('\n');
            if (LOGS.length() > 16_000) LOGS.delete(0, LOGS.length() - 16_000);
        }
    }

    private static String tailLogs() {
        String logs = lastLogs().trim();
        if (logs.isEmpty()) return "（没有核心日志，请检查安装包是否完整）";
        if (logs.length() > 1800) return logs.substring(logs.length() - 1800);
        return logs;
    }

    private static void copyAssetTree(Context ctx, String assetPath, File target) throws IOException {
        String[] children = ctx.getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            copyAsset(ctx, assetPath, target);
            return;
        }
        if (!target.isDirectory() && !target.mkdirs()) throw new IOException("目录创建失败：" + target);
        for (String child : children) {
            copyAssetTree(ctx, assetPath + "/" + child, new File(target, child));
        }
    }

    private static void copyAsset(Context ctx, String assetPath, File target) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("目录创建失败：" + parent);
        }
        try (InputStream in = ctx.getAssets().open(assetPath);
             FileOutputStream out = new FileOutputStream(target)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
    }

    private static void deleteTree(File file) {
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteTree(child);
            }
        }
        if (!file.delete()) Log.w("HorunCore", "删除失败：" + file);
    }

    private static String readText(File file) throws IOException {
        List<String> lines = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new java.io.FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) lines.add(line);
        }
        return String.join("\n", lines);
    }

    private static void writeText(File file, String text) throws IOException {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }
}
