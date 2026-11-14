package com.codexlight.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class ServerConnectActivity extends Activity {
    private boolean pairingBusy=false;
    private EditText editHost;
    private EditText editPort;
    private EditText editToken;
    private LinearLayout recentSection;
    private LinearLayout recentListContainer;
    private ServerConfigManager configManager;
    private android.widget.CheckBox autoConnect;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_connect);

        configManager = new ServerConfigManager(this);
        autoConnect = findViewById(R.id.autoConnect);
        autoConnect.setChecked(configManager.isAutoConnectEnabled());
        autoConnect.setOnCheckedChangeListener((button, checked) -> configManager.setAutoConnectEnabled(checked));

        editHost = findViewById(R.id.editHost);
        editPort = findViewById(R.id.editPort);
        editToken = findViewById(R.id.editToken);
        recentSection = findViewById(R.id.recentSection);
        recentListContainer = findViewById(R.id.recentListContainer);

        Button scan=new Button(this);scan.setText("扫描电脑二维码");
        ((LinearLayout)findViewById(R.id.btnQuickPaste).getParent()).addView(scan);
        scan.setOnClickListener(v->startActivityForResult(new Intent(this,QrScanActivity.class),42));
        Button updates=new Button(this);updates.setText("查看 APK 发布与更新");((LinearLayout)findViewById(R.id.btnQuickPaste).getParent()).addView(updates);
        updates.setOnClickListener(v->startActivity(new Intent(Intent.ACTION_VIEW,android.net.Uri.parse("https://github.com/k08255-lxm/codex-light/releases"))));
        // Quick Paste action
        findViewById(R.id.btnQuickPaste).setOnClickListener(v -> pasteFromClipboard());

        // Connect button
        findViewById(R.id.btnConnect).setOnClickListener(v -> performConnect());

        // Demo Mode button
        findViewById(R.id.btnDemo).setOnClickListener(v -> launchDemoMode());

        // Clear history button
        findViewById(R.id.btnClearHistory).setOnClickListener(v -> {
            configManager.clearHistory();
            refreshHistoryUI();
        });

        // Populate with last used config
        ServerConfig last = configManager.getCurrent();
        if (last != null) {
            editHost.setText(last.getHost());
            editPort.setText(String.valueOf(last.getPort()));
            editToken.setText(last.getToken());
        }

        refreshHistoryUI();

        if (getIntent().getBooleanExtra("demo", false)) {
            launchDemoMode();
        } else if (savedInstanceState == null && !getIntent().getBooleanExtra("manual", false)
                && configManager.isAutoConnectEnabled() && last != null
                && ReconnectPolicy.eligible(last.getHost(), last.getPort(), last.getToken())) {
            launchConnection(last, true);
        }
        if (configManager.hasStorageError()) Toast.makeText(this,
            "已保存的连接无法解密，请重新配对；没有发送旧凭据。", Toast.LENGTH_LONG).show();
    }

    @Override protected void onResume(){super.onResume();AppUpdateChecker.start(this);}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==42&&result==RESULT_OK&&data!=null)redeem(data.getStringExtra("pairing"));}
    private void redeem(String link){
        if(pairingBusy)return;
        new android.app.AlertDialog.Builder(this).setTitle("连接这台电脑？").setMessage("只扫描你自己电脑上的二维码。配对会允许本手机使用该电脑的 码舱 CodeCang；HTTP 仅适用于可信局域网。").setNegativeButton("取消",null).setPositiveButton("配对",(dialog,which)->{
         if(pairingBusy)return;pairingBusy=true;Toast.makeText(this,"正在配对…",Toast.LENGTH_SHORT).show();
         new Thread(()->{try{ServerConfig cfg=PairingClient.redeem(link);runOnUiThread(()->{pairingBusy=false;if(isFinishing()||isDestroyed())return;editHost.setText(cfg.getHost());editPort.setText(String.valueOf(cfg.getPort()));editToken.setText(cfg.getToken());performConnect();});}catch(Exception e){runOnUiThread(()->{pairingBusy=false;if(!isFinishing())new android.app.AlertDialog.Builder(this).setTitle("配对失败").setMessage("请确认同一网络，并在电脑重新生成二维码后重试。也可粘贴手动连接链接。").setPositiveButton("知道了",null).show();});}},"pairing").start();
        }).show();
    }
    @Override protected void onPause(){AppUpdateChecker.stop(this);super.onPause();}
    private void pasteFromClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence text = cm.getPrimaryClip().getItemAt(0).getText();
                if (text != null) {
                    if(PairingClient.isPairing(text.toString())){redeem(text.toString());return;}
                    ServerConfig parsed = ServerConfig.parse(text.toString());
                    if (parsed != null) {
                        editHost.setText(parsed.getHost());
                        editPort.setText(String.valueOf(parsed.getPort()));
                        editToken.setText(parsed.getToken());
                        Toast.makeText(this, "已成功解析链接并自动填充", Toast.LENGTH_SHORT).show();
                        return;
                    }
                }
            }
            Toast.makeText(this, "剪贴板中未发现有效的 码舱 CodeCang 局域网链接", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "读取剪贴板失败: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private void performConnect() {
        String host = editHost.getText().toString().trim();
        String portStr = editPort.getText().toString().trim();
        String token = editToken.getText().toString().trim();

        if (host.isEmpty()) {
            Toast.makeText(this, "请输入服务器 IP 或主机地址", Toast.LENGTH_SHORT).show();
            editHost.requestFocus();
            return;
        }

        int port = 80;
        if (!portStr.isEmpty()) {
            try {
                port = Integer.parseInt(portStr);
            } catch (Exception e) {
                Toast.makeText(this, "端口号格式不正确", Toast.LENGTH_SHORT).show();
                editPort.requestFocus();
                return;
            }
        }

        ServerConfig cfg = new ServerConfig(host, port, token);
        if (!ReconnectPolicy.eligible(cfg.getHost(), cfg.getPort(), cfg.getToken())) {
            Toast.makeText(this, "请输入电脑生成的私有 IPv4 地址、端口和完整访问令牌，或重新扫码配对。", Toast.LENGTH_LONG).show();
            return;
        }
        new android.app.AlertDialog.Builder(this)
            .setTitle("连接已配对的电脑？")
            .setMessage("请确认当前是可信局域网，地址属于你的电脑。HTTP 未加密；确认后会记住当前网络，下次打开 App 自动连接。更换网络或手机重启后需再次确认。")
            .setNegativeButton("取消", null)
            .setPositiveButton("确认连接", (dialog, which) -> launchConnection(cfg, false)).show();
    }

    private void launchConnection(ServerConfig cfg, boolean automatic) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("automatic", automatic);
        intent.putExtra("authorizedNetwork", automatic ? configManager.getNetworkBinding() : NetworkBinding.current(this));
        intent.putExtra("host", cfg.getHost());
        intent.putExtra("port", cfg.getPort());
        intent.putExtra("token", cfg.getToken());
        intent.putExtra("demo", false);
        startActivity(intent);
        finish();
    }

    private void launchDemoMode() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("demo", true);
        startActivity(intent);
        finish();
    }

    private void refreshHistoryUI() {
        List<ServerConfig> history = configManager.getHistory();
        recentListContainer.removeAllViews();
        if (history.isEmpty()) {
            recentSection.setVisibility(View.GONE);
            return;
        }
        recentSection.setVisibility(View.VISIBLE);
        LayoutInflater inflater = LayoutInflater.from(this);
        SimpleDateFormat sdf = new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault());

        for (ServerConfig item : history) {
            View row = inflater.inflate(R.layout.item_server_history, recentListContainer, false);
            TextView tvAddress = row.findViewById(R.id.tvHistoryAddress);
            TextView tvDate = row.findViewById(R.id.tvHistoryDate);
            View btnConnect = row.findViewById(R.id.btnConnectHistory);

            tvAddress.setText(item.toDisplayAddress());
            tvDate.setText("最近连接: " + sdf.format(new Date(item.getLastConnectedAt())));

            View.OnClickListener clickListener = v -> {
                editHost.setText(item.getHost());
                editPort.setText(String.valueOf(item.getPort()));
                editToken.setText(item.getToken());
                performConnect();
            };

            row.setOnClickListener(clickListener);
            btnConnect.setOnClickListener(clickListener);
            recentListContainer.addView(row);
        }
    }
}
