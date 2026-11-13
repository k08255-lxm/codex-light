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
    private EditText editHost;
    private EditText editPort;
    private EditText editToken;
    private LinearLayout recentSection;
    private LinearLayout recentListContainer;
    private ServerConfigManager configManager;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_connect);

        configManager = new ServerConfigManager(this);

        editHost = findViewById(R.id.editHost);
        editPort = findViewById(R.id.editPort);
        editToken = findViewById(R.id.editToken);
        recentSection = findViewById(R.id.recentSection);
        recentListContainer = findViewById(R.id.recentListContainer);

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
        }
    }

    private void pasteFromClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence text = cm.getPrimaryClip().getItemAt(0).getText();
                if (text != null) {
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
            Toast.makeText(this, "剪贴板中未发现有效的 Codex Light 局域网链接", Toast.LENGTH_SHORT).show();
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
        configManager.saveCurrent(cfg);

        Intent intent = new Intent(this, MainActivity.class);
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
