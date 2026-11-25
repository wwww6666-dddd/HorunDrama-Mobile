package com.horun.drama;

import android.content.Context;
import android.content.SharedPreferences;

/** 只存一个东西：电脑端核心的服务地址。 */
final class Prefs {
    private static final String FILE = "horun";
    private static final String KEY_SERVER = "server_url";

    private Prefs() {}

    static String server(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        return sp.getString(KEY_SERVER, "");
    }

    static void setServer(Context ctx, String url) {
        SharedPreferences sp = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        sp.edit().putString(KEY_SERVER, url).apply();
    }

    /** 用户输入 → 标准地址：补 http://、补默认 5881 端口、去掉结尾斜杠。 */
    static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        String hostPart = s.substring(s.indexOf("://") + 3);
        int slash = hostPart.indexOf('/');
        if (slash >= 0) hostPart = hostPart.substring(0, slash);
        if (!hostPart.contains(":")) s = s + ":5881";
        return s;
    }
}
