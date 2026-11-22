package com.codexlight.android;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.IOException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
public final class ReconnectTests {
    static int checks;
    static void check(boolean v) { checks++; if (!v) throw new AssertionError("check " + checks); }
    static class Fake extends HttpURLConnection {
        int status; boolean gone; String id; String type = "application/json";
        Fake(int status) throws Exception { super(new URL("http://192.168.1.2:3456/api/status")); this.status=status; }
        public String getContentType() { return type; }
        public String getHeaderField(String name) { return "X-CodeCang-Remote-Host-Id".equalsIgnoreCase(name) ? id : null; }
        public int getResponseCode() throws IOException { if(status<0) throw new IOException("offline"); return status; }
        public void disconnect(){gone=true;} public boolean usingProxy(){return false;} public void connect(){}
    }
    static final String ID = "e".repeat(32), LAN_TOKEN = "1".repeat(64), PUBLIC_TOKEN = "2".repeat(64);
    static final ServerConfig LAN = new ServerConfig("http", "192.168.1.2", 54321, LAN_TOKEN, ID);
    static final ServerConfig PUBLIC = new ServerConfig("https", "desk.example.com", 443, PUBLIC_TOKEN, ID);

    static class Routes {
        final List<String> contacted = new ArrayList<>();
        final List<String> nonces = new ArrayList<>();
        String proofKey = LAN_TOKEN, reported = ID;
        int lanStatus = 200, publicStatus = 200, proofStatus = 200;
        HttpURLConnection open(URL url) throws IOException {
            String address = url.toString();
            boolean local = address.startsWith(LAN.origin() + "/");
            check(local || address.startsWith(PUBLIC.origin() + "/"));
            boolean proof = url.getPath().equals("/api/pairing/prove");
            check(!proof || local);
            contacted.add(proof ? "prove" : local ? "lan" : "https");
            try {
                Fake response = new Fake(proof ? proofStatus : local ? lanStatus : publicStatus) {
                    final ByteArrayOutputStream body = new ByteArrayOutputStream();
                    public OutputStream getOutputStream() {
                        check(proof && getRequestProperty("Authorization") == null && "POST".equals(getRequestMethod()));
                        return body;
                    }
                    public int getResponseCode() throws IOException {
                        check(!getInstanceFollowRedirects());
                        if (!proof) {
                            check("GET".equals(getRequestMethod()));
                            check(("Bearer " + (local ? LAN_TOKEN : PUBLIC_TOKEN)).equals(getRequestProperty("Authorization")));
                        }
                        return super.getResponseCode();
                    }
                    public InputStream getInputStream() throws IOException {
                        String request = body.toString("UTF-8");
                        check(request.matches("\\{\"nonce\":\"[0-9a-f]{32}\"\\}"));
                        String nonce = request.substring(10,42);
                        check(!nonces.contains(nonce));
                        nonces.add(nonce);
                        try {
                            Mac hmac = Mac.getInstance("HmacSHA256");
                            hmac.init(new SecretKeySpec(proofKey.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
                            StringBuilder code = new StringBuilder();
                            for (byte b : hmac.doFinal(("codecang-lan-v1:" + nonce).getBytes(StandardCharsets.UTF_8))) {
                                code.append(String.format("%02x", b & 255));
                            }
                            return new ByteArrayInputStream(("{\"proof\":\"" + code + "\"}").getBytes(StandardCharsets.UTF_8));
                        } catch (java.security.GeneralSecurityException error) { throw new IOException(error); }
                    }
                };
                response.id = reported;
                return response;
            } catch (Exception failure) { throw new IOException(failure); }
        }

        void expect(ServerConfig chosen, List<ServerConfig> history, boolean auto, LanConnectionClient.Result result, String... calls) {
            contacted.clear();
            LanConnectionClient.Selection selection = new LanConnectionClient(this::open).select(chosen, history, auto);
            check(selection.result == result);
            check(contacted.equals(Arrays.asList(calls)));
            if (result == LanConnectionClient.Result.READY) {
                check(selection.target.origin().equals("https".equals(calls[calls.length - 1]) ? PUBLIC.origin() : LAN.origin()));
            }
        }
    }

    static void routing() {
        Routes routes = new Routes();
        List<ServerConfig> both = Arrays.asList(PUBLIC, LAN);
        routes.expect(PUBLIC, both, true, LanConnectionClient.Result.READY, "prove", "lan");
        routes.expect(LAN, both, true, LanConnectionClient.Result.READY, "prove", "lan");
        routes.expect(PUBLIC, both, false, LanConnectionClient.Result.READY, "https");
        routes.proofKey = PUBLIC_TOKEN;
        routes.expect(PUBLIC, both, true, LanConnectionClient.Result.READY, "prove", "https");
        routes.expect(LAN, Collections.emptyList(), true, LanConnectionClient.Result.UNPROVEN, "prove");
        routes.proofKey = LAN_TOKEN;
        routes.proofStatus = 307;
        routes.expect(LAN, both, true, LanConnectionClient.Result.READY, "prove", "https");
        routes.proofStatus = -1;
        routes.expect(PUBLIC, both, true, LanConnectionClient.Result.READY, "prove", "https");
        routes.proofStatus = 200;
        routes.lanStatus = -1;
        routes.expect(PUBLIC, both, true, LanConnectionClient.Result.READY, "prove", "lan", "https");
        for (int status : new int[]{401,403}) {
            routes.lanStatus = status;
            routes.expect(PUBLIC, both, true, LanConnectionClient.Result.UNAUTHORIZED, "prove", "lan");
        }
        routes.lanStatus = 200;
        routes.reported = "f".repeat(32);
        routes.expect(PUBLIC, both, true, LanConnectionClient.Result.WRONG_DEVICE, "prove", "lan");
        routes.reported = null;
        routes.expect(PUBLIC, both, true, LanConnectionClient.Result.WRONG_DEVICE, "prove", "lan");
        routes.expect(LAN.identified(""), both, true, LanConnectionClient.Result.READY, "lan");
        routes.reported = "invalid";
        routes.expect(LAN.identified(""), both, true, LanConnectionClient.Result.UNEXPECTED, "lan");
        routes.reported = ID;
        routes.contacted.clear();
        LanConnectionClient changedNetwork = new LanConnectionClient(routes::open, () -> routes.nonces.isEmpty());
        check(changedNetwork.select(PUBLIC, both, true).result == LanConnectionClient.Result.READY);
        check(routes.contacted.equals(Arrays.asList("https")));
        Routes changedAfterProof = new Routes();
        changedNetwork = new LanConnectionClient(changedAfterProof::open, () -> changedAfterProof.nonces.isEmpty());
        check(changedNetwork.select(PUBLIC, both, true).result == LanConnectionClient.Result.READY);
        check(changedAfterProof.contacted.equals(Arrays.asList("prove", "https")));
        routes.expect(PUBLIC, Arrays.asList(LAN.identified("f".repeat(32))), true, LanConnectionClient.Result.READY, "https");
        routes.expect(PUBLIC.identified(""), both, true, LanConnectionClient.Result.READY, "https");
    }

    static void sharedAddressHistory() {
        String otherId = ID.substring(0, 8) + "f".repeat(24);
        String otherToken = "3".repeat(64);
        ServerConfig other = new ServerConfig("http", LAN.getHost(), LAN.getPort(), otherToken, otherId);
        ServerConfig rotated = new ServerConfig("http", LAN.getHost(), LAN.getPort(), "4".repeat(64), ID);
        List<ServerConfig> recorded = ConnectionHistory.record(LAN, Arrays.asList(other, LAN.identified(""), PUBLIC));
        check(recorded.equals(Arrays.asList(LAN, other, PUBLIC)));
        check(!LAN.sourceKey().equals(other.sourceKey()));
        check(!LAN.sourceKey().equals(LAN.identified("").sourceKey()));
        check(!ConnectionHistory.deviceLabel(LAN, recorded).equals(ConnectionHistory.deviceLabel(other, recorded)));
        check(!ConnectionHistory.deviceLabel(other, recorded).contains(otherToken));
        check(ConnectionHistory.record(rotated, recorded).equals(Arrays.asList(rotated, other, PUBLIC)));
        check(ConnectionHistory.record(LAN, Arrays.asList(other.identified(""))).size() == 2);
        check(ConnectionHistory.record(LAN.identified(""), Arrays.asList(other, LAN)).size() == 3);
        check(ConnectionHistory.record(LAN.identified(""), Arrays.asList(LAN.identified(""))).size() == 1);
        Routes routes = new Routes();
        routes.expect(PUBLIC, Arrays.asList(other, LAN), true, LanConnectionClient.Result.READY, "prove", "lan");
        routes.proofKey = otherToken;
        routes.expect(PUBLIC, Arrays.asList(other, LAN), true, LanConnectionClient.Result.READY, "prove", "https");
    }

    public static void main(String[] args) throws Exception {
        sharedAddressHistory();
        routing();
        String token="a".repeat(64);
        ServerConfig https = ServerConfig.parse("https://Desk.Example.com:443/#token=" + token);
        check(https != null && https.eligible() && https.origin().equals("https://desk.example.com"));
        check(https.matchesOrigin("https://desk.example.com:443/api/status"));
        check(!https.matchesOrigin("https://desk.example.com:444/") && !https.matchesOrigin("http://desk.example.com:443/"));
        check(!https.matchesOrigin("https://user@desk.example.com/") && !https.matchesOrigin("https://desk.example.com.evil/"));
        check(ServerConfig.fromFields("https://desk.example.com", "", token).origin().equals(https.origin()));
        check(ServerConfig.fromFields("https://desk.example.com:8443", "443", token) == null);
        check(ServerConfig.fromFields("desk.example.com", "443", token) == null);
        check(ServerConfig.link("https://desk.example.com:8443/#pair=" + token, "pair") != null);
        check(ServerConfig.link("http://192.168.0.1:54321/#pair=" + token, "pair") != null);
        check(ServerConfig.parse("http://10.0.0.1/#token=" + token).origin().equals("http://10.0.0.1"));
        for (String origin : new String[]{"http://desk.example.com", "http://8.8.8.8", "https://127.0.0.1",
                "https://localhost", "https://x.localhost", "https://abc.trycloudflare.com", "https://192.0.2.1",
                "https://[::1]", "https://user@desk.example.com", "https://desk.example.com:0",
                "https://desk.example.com:", "https://desk.example.com:65536", "https://desk.example.com:bad",
                "https://desk.example.com/path", "https://desk.example.com/?token=secret", "https://example.com%2F.evil.com"}) {
            check(ServerConfig.parse(origin + "/#token=" + token) == null);
            check(ServerConfig.link(origin + "/#pair=" + token, "pair") == null);
        }
        Fake redirect = new Fake(307);
        LanConnectionClient remote = new LanConnectionClient(url -> {
            check(url.toString().equals("https://desk.example.com/api/status"));
            return redirect;
        });
        check(remote.select(https, Collections.emptyList(), false).result == LanConnectionClient.Result.UNEXPECTED);
        check(!redirect.getInstanceFollowRedirects());
        check(("Bearer " + token).equals(redirect.getRequestProperty("Authorization")));
        for(String ip:new String[]{"10.0.0.1","172.16.0.1","172.31.255.255","192.168.1.2"}) check(new ServerConfig("http", ip,1234,token).eligible());
        for(String ip:new String[]{"127.0.0.1","8.8.8.8","0.0.0.0","172.32.0.1","192.168.01.2","192.168.1.256","host.local","192.168.1.2@evil"}) check(!new ServerConfig("http",ip,1234,token).eligible());
        check(!new ServerConfig("http", "10.0.0.1",65536,token).eligible()); check(!new ServerConfig("http", "10.0.0.1",1,"bad\r\nHeader").eligible());
        ServerConfig cfg=new ServerConfig("http","192.168.1.2",3456,token);
        for(int status:new int[]{200,401,403,302,500,-1}) {
            Fake f=new Fake(status); LanConnectionClient client=new LanConnectionClient(url->{check(!url.toString().contains(token)); return f;});
            LanConnectionClient.Result r=client.select(cfg, Collections.emptyList(), true).result;
            check(r==(status==200?LanConnectionClient.Result.READY:(status==401||status==403?LanConnectionClient.Result.UNAUTHORIZED:(status<0?LanConnectionClient.Result.UNAVAILABLE:LanConnectionClient.Result.UNEXPECTED))));
            check(!f.getInstanceFollowRedirects()); check(f.getConnectTimeout()==5000); check(f.getReadTimeout()==5000); check(f.gone);
        }
        Fake f=new Fake(200); LanConnectionClient cancelled=new LanConnectionClient(url->f); cancelled.cancel();
        check(cancelled.select(cfg, Collections.emptyList(), true).result==LanConnectionClient.Result.UNAVAILABLE); check(!f.gone);
        LanConnectionClient invalid=new LanConnectionClient(url->{throw new AssertionError("must not send");});
        check(invalid.select(new ServerConfig("http","8.8.8.8",80,token), Collections.emptyList(), false).result==LanConnectionClient.Result.INVALID);
        System.out.println("Android reconnect policy/transport: "+checks+" assertions passed");
    }
}
