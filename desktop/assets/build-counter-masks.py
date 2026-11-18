"""Regenerate the Windows taskbar masks with PySide6 and Pillow (development only)."""
import gzip
import hashlib
import struct
from math import floor
from pathlib import Path

from PIL import Image
from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtGui import QColor, QFont, QFontDatabase, QFontMetricsF, QGuiApplication, QIcon, QImage, QPainter, QPixmap

ROOT = Path(__file__).resolve().parent
SIZES = (16, 20, 24, 32)
# Windows uses 16 and 32 pixel counter layers and asks Qt for the target icon size.
# https://github.com/telegramdesktop/tdesktop/blob/a532622be61ffb811c34311583c9fd4828786833/Telegram/SourceFiles/window/main_window.cpp
LAYOUT = {16: [(11, 5, 8), (11, 2, 7), (8, 1, 3)], 32: [(22, 9, 16), (20, 4, 14), (16, 2, 8)]}


def layer(text, size):
    em, padding, radius = LAYOUT[size][min(3, len(text)) - 1]
    font = QFont("Open Sans")
    font.setPixelSize(em)
    rounded = lambda value: floor(value + .5)
    natural_height = rounded(QFontMetricsF(font).height())
    for px in range(em, 0, -1):
        font.setPixelSize(px)
        metrics = QFontMetricsF(font)
        advance = rounded(metrics.horizontalAdvance(text))
        if advance + padding + max(1, padding - 1) <= size:
            break
    height = rounded(metrics.height())
    width = min(size, advance + 2 * padding)
    corner = min(height / 2, radius * height / natural_height)
    image = QImage(size, size, QImage.Format_ARGB32)
    image.fill(Qt.transparent)
    painter = QPainter(image)
    painter.setRenderHints(QPainter.Antialiasing | QPainter.TextAntialiasing)
    painter.setPen(Qt.NoPen)
    painter.setBrush(QColor("black"))
    painter.drawRoundedRect(QRect(size - width, size - height, width, height), corner, corner)
    painter.setFont(font)
    painter.setPen(Qt.white)
    painter.drawText(size - padding - advance, size - height + rounded(metrics.ascent()), text)
    painter.end()
    return QPixmap.fromImage(image)


def build():
    font = (ROOT / "OpenSans-Regular.ttf").read_bytes()
    blob = b"blob " + str(len(font)).encode() + b"\0" + font
    if hashlib.sha1(blob).hexdigest() != "6a6073d0fbc3a7fb716dd80393a6f9fc85c72453":
        raise ValueError("Unexpected Open Sans font revision")
    app = QGuiApplication([])
    assert QFontDatabase.addApplicationFont(str(ROOT / "OpenSans-Regular.ttf")) >= 0
    labels = [f"{n}{suffix}" for suffix in ("", "K", "M", "B") for n in range(1, 1000)] + ["999B+"]
    blocks = {size: [] for size in SIZES}
    for start in range(0, len(labels), 32):
        group = {size: bytearray() for size in SIZES}
        for text in labels[start:start + 32]:
            icon = QIcon()
            for size in LAYOUT:
                icon.addPixmap(layer(text, size))
            for size in SIZES:
                img = icon.pixmap(QSize(size, size),1.0).toImage().convertToFormat(QImage.Format_RGBA8888)
                assert img.size() == QSize(size, size)
                rgba = Image.frombytes("RGBA", (size, size), bytes(img.bits()))
                group[size].extend(Image.merge("LA", (rgba.getchannel("R"), rgba.getchannel("A"))).tobytes())
        for size in SIZES:
            blocks[size].append(gzip.compress(group[size], mtime=0))
    chunks = [chunk for size in SIZES for chunk in blocks[size]]
    offset = (len(chunks) + 1) * 4
    offsets = [offset]
    for chunk in chunks:
        offsets.append(offsets[-1] + len(chunk))
    (ROOT / "taskbar-counts.bin").write_bytes(struct.pack(f"<{len(offsets)}I", *offsets) + b"".join(chunks))


if __name__ == "__main__":
    build()
