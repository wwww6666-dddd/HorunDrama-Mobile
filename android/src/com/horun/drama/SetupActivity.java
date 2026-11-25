package com.horun.drama;

import android.app.Activity;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 首次启动 / 换电脑时填地址。
 *
 * 输入 IP 会自动补成 http://<ip>:5881；点「连接」先真的请求一次 /api/health，
 * 通了才保存，避免存了个错地址每次进来都是白屏。
 */
public class SetupActivity extends Activity {

    private EditText address;
    private TextView status;
    private Button connect;
    private Button force;
    private String pendingUrl = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_setup);

        address = findViewById(R.id.address);
        status = findViewById(R.id.status);
        connect = findViewById(R.id.connectBtn);
        force = findViewById(R.id.forceBtn);

        String saved = Prefs.server(this);
        if (!saved.isEmpty()) address.setText(saved);

        connect.setOnClickListener(v -> tryConnect());
        force.setOnClickListener(v -> {
            if (pendingUrl.isEmpty()) return;
            Prefs.setServer(this, pendingUrl);
            finish();
        });
    }

    private void tryConnect() {
        String normalized = Prefs.normalize(address.getText().toString());
        if (normalized.isEmpty()) {
            status.setText(getString(R.string.setup_empty));
            status.setTextColor(0xFFB9B0A6);
            return;
        }
        address.setText(normalized);
        connect.setEnabled(false);
        status.setTextColor(0xFFB9B0A6);
        status.setText(getString(R.string.setup_checking));

        new Thread(() -> {
            String error = probe(normalized);
            runOnUiThread(() -> {
                connect.setEnabled(true);
                if (error == null) {
                    Prefs.setServer(this, normalized);
                    status.setTextColor(0xFF54D68A);
                    status.setText("已连上电脑端核心");
                    finish();
                } else {
                    pendingUrl = normalized;
                    status.setTextColor(0xFFFF6A45);
                    status.setText("连不上：" + error + "\n检查电脑上的核心是否在运行、是否在同一个 Wi-Fi。");
                    force.setVisibility(View.VISIBLE);
                }
            });
        }).start();
    }

    /** 返回 null 表示通了，否则返回原因。 */
    private String probe(String base) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(base + "/api/health");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            if (code != 200) return "HTTP " + code;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
            }
            return TextUtils.isEmpty(sb.toString()) ? "响应为空" : null;
        } catch (Exception e) {
            String msg = e.getMessage();
            return msg == null || msg.isEmpty() ? e.getClass().getSimpleName() : msg;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
