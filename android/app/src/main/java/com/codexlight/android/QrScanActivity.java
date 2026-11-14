package com.codexlight.android;
import android.app.Activity;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
/** Camera is active only on this visible scan screen. Frames never leave the device. */
@SuppressWarnings("deprecation")
public final class QrScanActivity extends Activity implements SurfaceHolder.Callback {
 private Camera camera;private SurfaceView preview;private TextView hint;private boolean surfaceReady=false,decoding=false,finished=false;
 @Override public void onCreate(Bundle b){super.onCreate(b);getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
  LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(24,24,24,24);
  hint=new TextView(this);hint.setText("扫描电脑的二维码。画面仅在本机识别，不上传。");hint.setTextSize(17);root.addView(hint);
  preview=new SurfaceView(this);root.addView(preview,new LinearLayout.LayoutParams(-1,0,1));preview.getHolder().addCallback(this);
  Button cancel=new Button(this);cancel.setText("取消扫描");cancel.setOnClickListener(v->finish());root.addView(cancel);setContentView(root);
  if(checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.CAMERA},42);
 }
 @Override public void onRequestPermissionsResult(int r,String[] p,int[] results){super.onRequestPermissionsResult(r,p,results);if(r==42){if(results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)open();else hint.setText("未授权相机。返回后仍可粘贴电脑的配对链接。");}}
 @Override public void surfaceCreated(SurfaceHolder h){surfaceReady=true;open();}
 @Override public void surfaceChanged(SurfaceHolder h,int f,int w,int height){}
 @Override public void surfaceDestroyed(SurfaceHolder h){surfaceReady=false;release();}
 @Override protected void onResume(){super.onResume();open();}
 @Override protected void onPause(){release();super.onPause();}
 private void release(){if(camera!=null){Camera old=camera;camera=null;try{old.setPreviewCallback(null);old.stopPreview();}catch(RuntimeException ignored){}finally{old.release();}}}
 private void open(){if(!surfaceReady||camera!=null||finished||checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)return;
  try{camera=Camera.open();Camera.Parameters p=camera.getParameters();if(p.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE))p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);camera.setParameters(p);camera.setDisplayOrientation(90);camera.setPreviewDisplay(preview.getHolder());camera.setPreviewCallback((data,cam)->decode(data,cam));camera.startPreview();}
  catch(Exception e){release();hint.setText("无法打开相机，请关闭其他相机应用，或返回粘贴链接。");}
 }
 private void decode(byte[] data,Camera cam){if(decoding||finished)return;decoding=true;Camera.Size size=cam.getParameters().getPreviewSize();byte[] frame=data.clone();
  new Thread(()->{String text=null;try{PlanarYUVLuminanceSource source=new PlanarYUVLuminanceSource(frame,size.width,size.height,0,0,size.width,size.height,false);text=new com.google.zxing.qrcode.QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source))).getText();}catch(Exception ignored){}
   final String result=text;runOnUiThread(()->{decoding=false;if(result==null||finished||isFinishing()||camera==null)return;if(!PairingClient.isPairing(result)){hint.setText("这不是 Codex Light 配对码，请扫描电脑设置中的二维码。");return;}finished=true;setResult(RESULT_OK,new Intent().putExtra("pairing",result));finish();});
  },"qr-decode").start();
 }
}
