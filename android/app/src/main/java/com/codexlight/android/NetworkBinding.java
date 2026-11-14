package com.codexlight.android;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.LinkProperties;
import android.provider.Settings;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;

/** Fail closed across Wi-Fi changes and reboot without requesting location/SSID access. */
final class NetworkBinding {
    private static int leaseSerial;
    static synchronized int bind(Context context, String expected) {
        try {
            ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network network = manager.getActiveNetwork();
            if (network == null || !matches(expected, current(context)) || !network.equals(manager.getActiveNetwork())) return 0;
            return manager.bindProcessToNetwork(network) ? ++leaseSerial : 0;
        } catch (Exception unavailable) { return 0; }
    }
    static synchronized void release(Context context, int lease) {
        if (lease == 0 || lease != leaseSerial) return;
        try { ((ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE)).bindProcessToNetwork(null); }
        catch (Exception unavailable) { /* No broader-network fallback on release failure. */ }
        finally { leaseSerial++; }
    }
    static String current(Context context) {
        try {
            ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network network = manager.getActiveNetwork();
            if (network == null) return "";
            NetworkCapabilities caps = manager.getNetworkCapabilities(network);
            LinkProperties links = manager.getLinkProperties(network);
            if (caps == null || links == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                || !(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) return "";
            int boot = Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT);
            ArrayList<String> properties = new ArrayList<>();
            properties.add(String.valueOf(links.getInterfaceName()));
            links.getLinkAddresses().forEach(value -> properties.add(value.toString()));
            links.getRoutes().forEach(value -> properties.add(value.toString()));
            Collections.sort(properties);
            String raw = boot + ":" + network.getNetworkHandle() + ":" + String.join("|", properties);
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte value : hash) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return result.toString();
        } catch (Exception unavailable) { return ""; }
    }
    static java.net.HttpURLConnection open(Context context, String expected, java.net.URL url) throws Exception {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network network = manager.getActiveNetwork();
        if (network == null || !matches(expected, current(context)) || !network.equals(manager.getActiveNetwork()))
            throw new java.io.IOException("Network changed");
        // Bind the request to this network. A default-network switch cannot forward the bearer elsewhere.
        return (java.net.HttpURLConnection) network.openConnection(url);
    }
    static boolean matches(String saved, String current) {
        return saved != null && !saved.isEmpty() && saved.equals(current);
    }
}
