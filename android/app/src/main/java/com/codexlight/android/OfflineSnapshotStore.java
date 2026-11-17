package com.codexlight.android;

import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/** Private noBackupDir storage, one atomic snapshot per address, at most eight addresses. */
final class OfflineSnapshotStore {
    private final File root;
    OfflineSnapshotStore(File noBackupDir) { root = new File(noBackupDir, "offline-snapshots"); }

    private AtomicFile file(String key) throws IOException {
        if (!key.matches("[a-f0-9]{64}")) throw new IOException("Invalid snapshot identity");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot create snapshot directory");
        return new AtomicFile(new File(root, key + ".snapshot"));
    }

    OfflineSnapshotData read(String key) throws IOException {
        AtomicFile file = file(key);
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath() + ".bak").exists()) return null;
        try (FileInputStream in = file.openRead(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int size;
            while ((size = in.read(buffer)) != -1) {
                if (bytes.size() + size > OfflineSnapshotData.MAX_BYTES) throw new IOException("Snapshot too large");
                bytes.write(buffer, 0, size);
            }
            return OfflineSnapshotData.decode(bytes.toByteArray());
        }
    }

    void save(String key, OfflineSnapshotData snapshot) throws IOException {
        byte[] bytes = snapshot.encode();
        AtomicFile file = file(key);
        FileOutputStream out = null;
        try {
            out = file.startWrite(); out.write(bytes); file.finishWrite(out);
        } catch (IOException failure) { if (out != null) file.failWrite(out); throw failure; }
        File[] files = root.listFiles((directory, name) -> name.matches("[a-f0-9]{64}\\.snapshot(?:\\.bak|\\.new)?"));
        if (files == null) return;
        Map<String, Long> modified = new HashMap<>();
        for (File entry : files) {
            String identity = entry.getName().substring(0, 64);
            modified.put(identity, Math.max(modified.getOrDefault(identity, 0L), entry.lastModified()));
        }
        for (String staleKey : OfflineSnapshotData.staleSnapshotKeys(modified, key)) {
            File base = new File(root, staleKey + ".snapshot");
            new AtomicFile(base).delete();
            // Also remove a modern AtomicFile temporary left by an older process.
            File temporary = new File(base.getPath() + ".new");
            if (temporary.exists() && !temporary.delete()) throw new IOException("Cannot prune old snapshot");
        }
    }
}
