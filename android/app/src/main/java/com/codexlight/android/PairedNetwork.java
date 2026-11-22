package com.codexlight.android;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import java.net.HttpURLConnection;

/** Observe the default network without changing Android's Wi-Fi or VPN routing. */
final class PairedNetwork {
    static Network current(Context context) {
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        return manager == null ? null : manager.getActiveNetwork();
    }

    static boolean unchanged(Context context, Network network) {
        return network != null && network.equals(current(context));
    }

    static LanConnectionClient client(Context context, Network network) {
        return new LanConnectionClient(url -> (HttpURLConnection) url.openConnection(),
            () -> unchanged(context, network));
    }
}
