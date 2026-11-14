package com.codexlight.android;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.IOException;
public final class ReconnectTests {
    static int checks;
    static void check(boolean v) { checks++; if (!v) throw new AssertionError("check " + checks); }
    static class Fake extends HttpURLConnection {
        int status; boolean gone;
        Fake(int status) throws Exception { super(new URL("http://192.168.1.2:3456/api/status")); this.status=status; }
        public int getResponseCode() throws IOException { if(status<0) throw new IOException("offline"); return status; }
        public void disconnect(){gone=true;} public boolean usingProxy(){return false;} public void connect(){}
    }
    public static void main(String[] args) throws Exception {
        String token="a".repeat(64);
        for(String ip:new String[]{"10.0.0.1","172.16.0.1","172.31.255.255","192.168.1.2"}) check(ReconnectPolicy.eligible(ip,1234,token));
        for(String ip:new String[]{"127.0.0.1","8.8.8.8","0.0.0.0","172.32.0.1","192.168.01.2","192.168.1.256","host.local","192.168.1.2@evil"}) check(!ReconnectPolicy.eligible(ip,1234,token));
        check(!ReconnectPolicy.eligible("10.0.0.1",65536,token)); check(!ReconnectPolicy.eligible("10.0.0.1",1,"bad\r\nHeader"));
        ServerConfig cfg=new ServerConfig("192.168.1.2",3456,token);
        for(int status:new int[]{200,401,403,302,500,-1}) {
            Fake f=new Fake(status); LanConnectionClient client=new LanConnectionClient(url->{check(!url.toString().contains(token)); return f;});
            LanConnectionClient.Result r=client.check(cfg);
            check(r==(status==200?LanConnectionClient.Result.READY:(status==401||status==403?LanConnectionClient.Result.UNAUTHORIZED:LanConnectionClient.Result.UNAVAILABLE)));
            check(!f.getInstanceFollowRedirects()); check(f.getConnectTimeout()==5000); check(f.getReadTimeout()==5000); check(f.gone);
        }
        Fake f=new Fake(200); LanConnectionClient cancelled=new LanConnectionClient(url->f); cancelled.cancel();
        check(cancelled.check(cfg)==LanConnectionClient.Result.UNAVAILABLE); check(f.gone);
        LanConnectionClient invalid=new LanConnectionClient(url->{throw new AssertionError("must not send");});
        check(invalid.check(new ServerConfig("8.8.8.8",80,token))==LanConnectionClient.Result.INVALID);
        System.out.println("Android reconnect policy/transport: "+checks+" assertions passed");
    }
}
