package com.codexlight.android;
import android.net.Uri;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.ByteArrayOutputStream;
public final class PairingClient {
 public static boolean isPairing(String text) { return text != null && text.contains("#pair="); }
 public static ServerConfig redeem(String text) throws Exception {
  Uri uri=Uri.parse(text);String host=uri.getHost();int port=uri.getPort();
  if(!"http".equals(uri.getScheme())||uri.getUserInfo()!=null||uri.getQuery()!=null||!"/".equals(uri.getPath())||port<1||port>65535||!privateIp(host))throw new Exception("请扫描电脑生成的局域网配对码");
  String fragment=uri.getFragment();if(fragment==null||!fragment.matches("pair=[a-f0-9]{64}"))throw new Exception("配对码无效");
  HttpURLConnection c=(HttpURLConnection)new URL("http://"+host+":"+port+"/api/pairing/redeem").openConnection();
  c.setInstanceFollowRedirects(false);c.setConnectTimeout(8000);c.setReadTimeout(8000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
  try { byte[] bytes=new JSONObject().put("ticket",fragment.substring(5)).toString().getBytes("UTF-8");c.setFixedLengthStreamingMode(bytes.length);try(java.io.OutputStream out=c.getOutputStream()){out.write(bytes);}
   if(c.getResponseCode()!=200)throw new Exception("二维码已使用或过期，请在电脑重新生成");
   ByteArrayOutputStream out=new ByteArrayOutputStream();try(java.io.InputStream in=c.getInputStream()){byte[] b=new byte[512];int n;while((n=in.read(b))!=-1){out.write(b,0,n);if(out.size()>2048)throw new Exception("配对响应无效");}}
   String token=new JSONObject(out.toString("UTF-8")).getString("token");if(!token.matches("[a-f0-9]{64}"))throw new Exception("配对响应无效");return new ServerConfig(host,port,token);
  }finally{c.disconnect();}
 }
 private static boolean privateIp(String host){
  if(host==null||!host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+"))return false;
  String[] parts=host.split("\\.");int[] n=new int[4];try{for(int i=0;i<4;i++){n[i]=Integer.parseInt(parts[i]);if(n[i]>255||!parts[i].equals(String.valueOf(n[i])))return false;}}catch(Exception e){return false;}
  return n[0]==10||(n[0]==172&&n[1]>=16&&n[1]<=31)||(n[0]==192&&n[1]==168);
 }
}
