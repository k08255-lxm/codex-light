package com.codexlight.android;

/** No network scanning, DNS rebinding or redirect-based credential forwarding. */
final class ReconnectPolicy {
    static boolean privateIpv4(String host) {
        if (host == null || !host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
        String[] parts = host.split("\\."); int[] n = new int[4];
        try { for (int i=0;i<4;i++) { n[i]=Integer.parseInt(parts[i]);
            if (n[i]>255 || !parts[i].equals(String.valueOf(n[i]))) return false;
        }} catch (Exception error) { return false; }
        return n[0]==10 || (n[0]==172 && n[1]>=16 && n[1]<=31) || (n[0]==192 && n[1]==168);
    }
    static boolean eligible(String host, int port, String token) {
        return privateIpv4(host) && port>0 && port<=65535 && token!=null && token.matches("[a-f0-9]{64}");
    }
    static boolean unauthorized(int status) { return status == 401 || status == 403; }
}
