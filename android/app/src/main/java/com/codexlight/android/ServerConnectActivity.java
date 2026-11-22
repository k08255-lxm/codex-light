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
    private ServerConfig filled;
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
        Button updates=new Button(this);updates.setText("检查更新");((LinearLayout)findViewById(R.id.btnQuickPaste).getParent()).addView(updates);
        updates.setOnClickListener(v->AppUpdateChecker.checkNow(this));
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
            fill(last);
        }

        refreshHistoryUI();

        if (getIntent().getBooleanExtra("demo", false)) {
            launchDemoMode();
        } else if (savedInstanceState == null && !getIntent().getBooleanExtra("manual", false)
                && configManager.isAutoConnectEnabled() && last != null
                && last.eligible()) {
            launchConnection(last, true);
        }
        if (configManager.hasStorageError()) Toast.makeText(this,
            "已保存的连接无法解密，请重新配对；没有发送旧凭据。", Toast.LENGTH_LONG).show();
    }

    @Override protected void onResume(){super.onResume();AppUpdateChecker.start(this);}
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 42 && result == RESULT_OK && data != null) acceptLink(data.getStringExtra("pairing"));
    }

    private void fill(ServerConfig config) {
        editHost.setText("https".equals(config.getScheme()) ? "https://" + config.getHost() : config.getHost());
        editPort.setText(String.valueOf(config.getPort()));
        editToken.setText(config.getToken());
        filled = config;
    }

    private boolean acceptLink(String text) {
        java.net.URI ticket = ServerConfig.link(text, "pair");
        if (ticket != null) { redeem(ticket); return true; }
        ServerConfig config = ServerConfig.parse(text);
        if (config == null) return false;
        fill(config);
        Toast.makeText(this, "已填入连接地址和令牌，请核对后连接。", Toast.LENGTH_SHORT).show();
        return true;
    }

    private void redeem(java.net.URI link) {
        if (pairingBusy) return;
        String origin = ServerConfig.pairingTarget(link).origin();
        new android.app.AlertDialog.Builder(this).setTitle("配对这台电脑？")
            .setMessage(origin + "\n\n请核对电脑上显示的地址。配对后，这部手机可使用该电脑的码舱工作台。")
            .setNegativeButton("取消", null).setPositiveButton("配对", (dialog, which) -> {
                if (pairingBusy) return;
                pairingBusy = true;
                Toast.makeText(this, "正在配对…", Toast.LENGTH_SHORT).show();
                new Thread(() -> {
                    try {
                        ServerConfig config = PairingClient.redeem(link);
                        runOnUiThread(() -> {
                            pairingBusy = false;
                            if (!isFinishing() && !isDestroyed()) launchConnection(config, false);
                        });
                    } catch (Exception failure) {
                        runOnUiThread(() -> {
                            pairingBusy = false;
                            if (!isFinishing() && !isDestroyed()) new android.app.AlertDialog.Builder(this)
                                .setTitle("配对失败").setMessage("请确认地址可达，再用电脑重新生成的二维码配对。")
                                .setPositiveButton("知道了", null).show();
                        });
                    }
                }, "pairing").start();
            }).show();
    }
    @Override protected void onPause(){AppUpdateChecker.stop(this);super.onPause();}
    private void pasteFromClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence text = cm.getPrimaryClip().getItemAt(0).getText();
                if (text != null && acceptLink(text.toString())) return;
            }
            Toast.makeText(this, "剪贴板中未发现有效的 码舱 CodeCang 配对或连接链接", Toast.LENGTH_SHORT).show();
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

        ServerConfig cfg = ServerConfig.fromFields(host, portStr, token);
        if (cfg == null || !cfg.eligible()) {
            Toast.makeText(this, "请输入私有 IPv4 或 https:// 固定域名、有效端口和完整访问令牌。", Toast.LENGTH_LONG).show();
            return;
        }
        if (filled != null && token.equals(filled.getToken()) && !cfg.origin().equals(filled.origin())) {
            Toast.makeText(this, "地址已改变，请粘贴新地址的连接链接或重新扫码配对。", Toast.LENGTH_LONG).show();
            return;
        }
        ServerConfig chosen = filled != null && token.equals(filled.getToken()) && cfg.origin().equals(filled.origin())
            ? filled : cfg;
        new android.app.AlertDialog.Builder(this)
            .setTitle("连接已配对的电脑？")
            .setMessage(cfg.origin() + (chosen.getRemoteHostId().isEmpty() ? "" : "\n电脑 ID " + chosen.getRemoteHostId())
                + "\n\n请确认地址属于你的电脑。自动连接会使用此地址，可在连接页关闭。")
            .setNegativeButton("取消", null)
            .setPositiveButton("确认连接", (dialog, which) -> launchConnection(chosen, false)).show();
    }

    private void launchConnection(ServerConfig cfg, boolean automatic) {
        Intent intent = workbenchIntent();
        MainActivity.putConnection(intent, cfg, automatic);
        startActivity(intent);
        finish();
    }

    private void launchDemoMode() {
        Intent intent = workbenchIntent();
        intent.putExtra("demo", true);
        startActivity(intent);
        finish();
    }

    private Intent workbenchIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        if (getIntent().getBooleanExtra("manual", false) && getIntent().getBooleanExtra("returnToWorkbench", false)) {
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        }
        return intent;
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

            tvAddress.setText(item.origin());
            tvDate.setText(ConnectionHistory.deviceLabel(item, history) + "\n最近连接 " + sdf.format(new Date(item.getLastConnectedAt())));

            View.OnClickListener clickListener = v -> {
                fill(item);
                performConnect();
            };

            row.setOnClickListener(clickListener);
            btnConnect.setOnClickListener(clickListener);
            recentListContainer.addView(row);
        }
    }
}
