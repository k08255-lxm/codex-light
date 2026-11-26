using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CodexLight.Shared {
    // Keep CheckBox's native toggle accessibility pattern, label hit area and Space handling.
    internal sealed class ToggleSwitch : CheckBox {
        readonly System.Windows.Forms.Timer animation = new System.Windows.Forms.Timer { Interval = 15 };
        readonly Stopwatch elapsed = new Stopwatch();
        float position, startPosition;

        public ToggleSwitch() {
            AutoSize = true;
            SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            animation.Tick += (sender, args) => {
                float progress = Math.Min(1f, elapsed.ElapsedMilliseconds / 120f);
                position = startPosition + ((Checked ? 1f : 0f) - startPosition) * progress;
                if (progress >= 1f) animation.Stop();
                Invalidate();
            };
        }

        int Px(int dip) => (int)Math.Round(dip * DeviceDpi / 96f);
        const TextFormatFlags LabelFlags = TextFormatFlags.NoPrefix | TextFormatFlags.WordBreak | TextFormatFlags.NoPadding;

        public override Size GetPreferredSize(Size proposedSize) {
            int fixedWidth = Px(4) + Px(34) + Px(8) + Px(4);
            int available = proposedSize.Width > fixedWidth ? proposedSize.Width - fixedWidth : int.MaxValue;
            var label = TextRenderer.MeasureText(Text, Font, new Size(available, int.MaxValue), LabelFlags);
            return new Size(fixedWidth + label.Width, Math.Max(Px(20), label.Height) + Px(8));
        }

        protected override void OnCheckedChanged(EventArgs e) {
            if (IsHandleCreated && Visible && SystemInformation.IsMenuAnimationEnabled && !SystemInformation.HighContrast) {
                startPosition = position;
                elapsed.Restart();
                animation.Start();
            } else {
                animation.Stop();
                position = Checked ? 1f : 0f;
            }
            Invalidate();
            base.OnCheckedChanged(e);
        }

        protected override void OnPaint(PaintEventArgs e) {
            var g = e.Graphics;
            int width = Px(34), height = Px(20), inset = Px(4);
            var track = new Rectangle(inset, (Height - height) / 2, width, height);
            bool dark = BackColor.GetBrightness() < .5f, highContrast = SystemInformation.HighContrast;
            Color background = highContrast ? SystemColors.Window : BackColor;
            Color foreground = highContrast ? SystemColors.WindowText : ForeColor;
            g.Clear(background);
            Color outline = highContrast ? SystemColors.WindowText : dark ? Color.FromArgb(140,145,150) : Color.FromArgb(112,120,130);
            Color fill = highContrast ? SystemColors.Window : dark ? Color.FromArgb(54,57,61) : Color.FromArgb(226,230,235);
            Color knob = outline;
            if (Checked) {
                fill = highContrast ? SystemColors.Highlight : dark ? Color.FromArgb(232,232,232) : Color.FromArgb(56,90,129);
                outline = highContrast ? SystemColors.WindowText : fill;
                knob = highContrast ? SystemColors.HighlightText : dark ? Color.FromArgb(24,24,24) : Color.White;
            }
            if (!Enabled) {
                outline = knob = SystemColors.GrayText;
                fill = background;
            }

            var previous = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pill = new GraphicsPath()) {
                int diameter = height - 1;
                pill.AddArc(track.Left, track.Top, diameter, diameter, 90, 180);
                pill.AddArc(track.Right - height, track.Top, diameter, diameter, 270, 180);
                pill.CloseFigure();
                using (var brush = new SolidBrush(fill)) g.FillPath(brush, pill);
                using (var pen = new Pen(outline, Math.Max(1f, DeviceDpi / 96f))) g.DrawPath(pen, pill);
            }
            float padding = Px(3), size = height - 2 * padding;
            float x = track.Left + padding + (width - height) * position;
            using (var brush = new SolidBrush(knob)) g.FillEllipse(brush, x, track.Top + padding, size, size);
            g.SmoothingMode = previous;
            int left = track.Right + Px(8);
            var label = new Rectangle(left, 0, Math.Max(0, Width - left - inset), Height);
            TextRenderer.DrawText(g, Text, Font, label, Enabled ? foreground : SystemColors.GrayText, LabelFlags | TextFormatFlags.VerticalCenter);
            if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(ClientRectangle, -1, -1), foreground, background);
        }

        protected override void Dispose(bool disposing) {
            if (disposing) animation.Dispose();
            base.Dispose(disposing);
        }
    }
}
