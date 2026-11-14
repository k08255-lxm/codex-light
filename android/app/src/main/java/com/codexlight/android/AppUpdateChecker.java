package com.codexlight.android;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import org.json.*;
import java.net.*;
import java.io.*;
/** Foreground checks only. Never downloads or installs without the user's action. */
public final class AppUpdateChecker {
 private static final android.os.Handler handler=new android.os.Handler(android.os.Looper.getMainLooper());
 private static final java.util.WeakHashMap<Activity,Runnable> timers=new java.util.WeakHashMap<>();
 public static void start(Activity activity){stop(activity);Runnable tick=new Runnable(){public void run(){if(!timers.containsKey(activity))return;check(activity);handler.postDelayed(this,600000L);}};timers.put(activity,tick);handler.post(tick);}
 public static void stop(Activity activity){Runnable task=timers.remove(activity);if(task!=null)handler.removeCallbacks(task);}
 private static boolean checking=false;private static final String REPO="https://github.com/k08255-lxm/codex-light/releases";
 public static synchronized void check(Activity activity){
  SharedPreferences prefs=activity.getSharedPreferences("app_updates",0);
  if(checking||System.currentTimeMillis()-prefs.getLong("checked",0)<21600000L)return;checking=true;
  new Thread(()->{String version=null;try{
   HttpURLConnection c=(HttpURLConnection)new URL("https://api.github.com/repos/k08255-lxm/codex-light/releases/latest").openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(8000);c.setReadTimeout(8000);c.setRequestProperty("Accept","application/vnd.github+json");
   JSONObject release;try{if(c.getResponseCode()!=200)throw new IOException();ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=c.getInputStream()){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1){out.write(b,0,n);if(out.size()>262144)throw new IOException();}}release=new JSONObject(out.toString("UTF-8"));}finally{c.disconnect();}
   String tag=release.getString("tag_name"),candidate=tag.replaceFirst("^v","");
   if(!candidate.matches("[0-9]+\\.[0-9]+\\.[0-9]+")||release.optBoolean("draft")||release.optBoolean("prerelease"))throw new IOException();
   boolean apk=false;JSONArray assets=release.getJSONArray("assets");for(int i=0;i<assets.length();i++){JSONObject a=assets.getJSONObject(i);if(("codex-light-"+candidate+".apk").equals(a.optString("name"))&&(REPO+"/download/"+tag+"/codex-light-"+candidate+".apk").equals(a.optString("browser_download_url")))apk=true;}
   String current=activity.getPackageManager().getPackageInfo(activity.getPackageName(),0).versionName;
   if(apk&&newer(candidate,current))version=candidate;
   if(version==null)prefs.edit().putLong("checked",System.currentTimeMillis()).apply();
  }catch(Exception ignored){/* Network failures are retried on next foreground, never reported as up-to-date. */}
  finally{synchronized(AppUpdateChecker.class){checking=false;}}
  final String found=version;activity.runOnUiThread(()->{if(found==null||activity.isFinishing()||activity.isDestroyed()||!timers.containsKey(activity))return;
   prefs.edit().putLong("checked",System.currentTimeMillis()).apply();
   if(found.equals(prefs.getString("notified","")))return;
   new AlertDialog.Builder(activity).setTitle("Codex Light v"+found+" 可用").setMessage("发现新版手机 APK。查看发布说明后自行下载；Android 会检查签名，只能用相同签名的新版本覆盖安装。不会自动安装，也不要为更新卸载现有应用。").setNegativeButton("稍后",(d,w)->prefs.edit().putString("notified",found).apply()).setPositiveButton("查看更新",(d,w)->{prefs.edit().putString("notified",found).apply();activity.startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(REPO+"/tag/v"+found)));}).show();
  });
  },"app-update-check").start();
 }
 static boolean newer(String candidate,String current){String[] a=candidate.split("\\."),b=current.split("\\.");if(a.length!=3||b.length!=3)return false;try{for(int i=0;i<3;i++){int x=Integer.parseInt(a[i]),y=Integer.parseInt(b[i]);if(x!=y)return x>y;}}catch(Exception ignored){}return false;}
}
