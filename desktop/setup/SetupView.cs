using System;
using System.Linq;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace CodexLight.Bootstrap {
 internal enum SetupStage { Checking, Ready, Installing, Failed, Cancelled, Completed }

 // Pure content: no Window, handles, detection, download or installation. Shared with the offscreen tests.
 internal sealed class SetupView : UserControl {
  internal readonly TextBox Location = new TextBox { IsReadOnly = true, IsReadOnlyCaretVisible = true, TextWrapping = TextWrapping.NoWrap, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, Padding = new Thickness(8, 6, 8, 6), BorderThickness = new Thickness(1), BorderBrush = Brush("#D8D8D8"), Background = Brushes.White, VerticalContentAlignment = VerticalAlignment.Center };
  internal readonly Button Change = new Button { Content = "更改…", MinWidth = 72, Height = 34, Margin = new Thickness(8, 0, 0, 0) };
  internal readonly Button Primary = new Button { Content = "安装", MinWidth = 96, Height = 34, IsDefault = true, IsEnabled = false };
  internal readonly Button Secondary = new Button { Content = "取消", MinWidth = 80, Height = 34, Margin = new Thickness(8, 0, 0, 0) };
  internal readonly TextBlock Status = new TextBlock { Text = "正在检查运行环境…", TextWrapping = TextWrapping.Wrap };
  internal readonly TextBlock Note = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Brush("#666666"), Margin = new Thickness(0, 8, 0, 0) };
  internal readonly TextBlock Mode = new TextBlock { Text = "安装 Codex Light", FontSize = 22, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
  internal readonly Expander DetailsToggle = new Expander { Header = "查看详情", Margin = new Thickness(0, 16, 0, 0), HorizontalContentAlignment = HorizontalAlignment.Stretch };
  internal readonly TextBox Details = new TextBox { IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Height = 168, MaxHeight = 180, Margin = new Thickness(0, 8, 0, 0), Padding = new Thickness(8), BorderThickness = new Thickness(1), BorderBrush = Brush("#D8D8D8"), Background = Brushes.White };
  internal readonly Grid Footer = new Grid { Margin = new Thickness(24, 16, 24, 24) };
  internal readonly ScrollViewer ContentScroll;
  readonly Image icon = new Image { Width = 28, Height = 28, Margin = new Thickness(0, 0, 12, 0) };
  bool registered, restartRequired, cancelAllowed;
  internal SetupStage Stage { get; private set; } = SetupStage.Checking;

  public SetupView() {
   Width = 544; FontSize = 13; FontFamily = new FontFamily("Segoe UI, Microsoft YaHei UI"); Foreground = Brush("#202020"); Background = Brush("#FAFAFA"); UseLayoutRounding = true; SnapsToDevicePixels = true;
   Resources.Add(typeof(Button), ButtonStyle()); Primary.Style = ButtonStyle(true);
   var layout = new Grid { Background = Background };
   layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
   var body = new StackPanel { Margin = new Thickness(24, 24, 24, 8) };
   var heading = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 24) };
   heading.Children.Add(icon); heading.Children.Add(Mode); body.Children.Add(heading);
   body.Children.Add(new TextBlock { Text = "安装位置", Margin = new Thickness(0, 0, 0, 8) });
   var path = new Grid(); path.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); path.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
   path.Children.Add(Location); Grid.SetColumn(Change, 1); path.Children.Add(Change); body.Children.Add(path);
   var state = new StackPanel { Margin = new Thickness(0, 24, 0, 0) }; state.Children.Add(Status); state.Children.Add(Note); body.Children.Add(state);
   DetailsToggle.Content = Details; DetailsToggle.Expanded += (_, __) => DetailsToggle.Header = "收起详情"; DetailsToggle.Collapsed += (_, __) => DetailsToggle.Header = "查看详情"; body.Children.Add(DetailsToggle);
   ContentScroll = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, CanContentScroll = false }; layout.Children.Add(ContentScroll);
   var divider = new Border { BorderBrush = Brush("#E6E6E6"), BorderThickness = new Thickness(0, 1, 0, 0), Child = Footer }; Grid.SetRow(divider, 1); layout.Children.Add(divider);
   Footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); Footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); Footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
   Grid.SetColumn(Primary, 1); Grid.SetColumn(Secondary, 2); Footer.Children.Add(Primary); Footer.Children.Add(Secondary); Content = layout;
   Location.TextChanged += (_, __) => { Location.ToolTip = Location.Text; Location.ScrollToHome(); };
   AutomationProperties.SetName(Location, "安装位置"); AutomationProperties.SetName(Change, "更改安装位置"); AutomationProperties.SetName(Details, "安装详情"); AutomationProperties.SetLiveSetting(Status, AutomationLiveSetting.Polite);
   KeyboardNavigation.SetTabIndex(Location, 0); KeyboardNavigation.SetTabIndex(Change, 1); KeyboardNavigation.SetTabIndex(DetailsToggle, 2); KeyboardNavigation.SetTabIndex(Details, 3); KeyboardNavigation.SetTabIndex(Primary, 4); KeyboardNavigation.SetTabIndex(Secondary, 5);
   SetStage(SetupStage.Checking, "正在检查运行环境…");
  }
  static SolidColorBrush Brush(string color) => (SolidColorBrush)new BrushConverter().ConvertFromString(color)!;
  static Style ButtonStyle(bool primary = false) {
   var style = new Style(typeof(Button));
   style.Setters.Add(new Setter(Control.BackgroundProperty, primary ? Brushes.Black : Brushes.White)); style.Setters.Add(new Setter(Control.ForegroundProperty, primary ? Brushes.White : Brush("#202020"))); style.Setters.Add(new Setter(Control.BorderBrushProperty, primary ? Brushes.Black : Brush("#CCCCCC"))); style.Setters.Add(new Setter(Control.BorderThicknessProperty, new Thickness(1))); style.Setters.Add(new Setter(Control.PaddingProperty, new Thickness(16, 0, 16, 0))); style.Setters.Add(new Setter(Control.HorizontalContentAlignmentProperty, HorizontalAlignment.Center)); style.Setters.Add(new Setter(Control.VerticalContentAlignmentProperty, VerticalAlignment.Center));
   var border = new FrameworkElementFactory(typeof(Border)); border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent }); border.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent }); border.SetValue(Border.BorderThicknessProperty, new Thickness(1)); border.SetValue(Border.CornerRadiusProperty, new CornerRadius(4));
   var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center); presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center); presenter.SetValue(FrameworkElement.MarginProperty, new Thickness(16, 0, 16, 0)); presenter.SetValue(ContentPresenter.RecognizesAccessKeyProperty, true); border.AppendChild(presenter);
   style.Setters.Add(new Setter(Control.TemplateProperty, new ControlTemplate(typeof(Button)) { VisualTree = border }));
   var disabled = new Trigger { Property = UIElement.IsEnabledProperty, Value = false }; disabled.Setters.Add(new Setter(UIElement.OpacityProperty, 0.45)); style.Triggers.Add(disabled);
   var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true }; hover.Setters.Add(new Setter(Control.BackgroundProperty, primary ? Brush("#333333") : Brush("#F0F0F0"))); style.Triggers.Add(hover);
   var pressed = new Trigger { Property = System.Windows.Controls.Primitives.ButtonBase.IsPressedProperty, Value = true }; pressed.Setters.Add(new Setter(UIElement.OpacityProperty, 0.7)); style.Triggers.Add(pressed);
   // Keep a visible keyboard indicator after replacing the native button template.
   var focusBorder = new FrameworkElementFactory(typeof(Border)); focusBorder.SetValue(Border.BorderBrushProperty, Brush("#0067C0")); focusBorder.SetValue(Border.BorderThicknessProperty, new Thickness(2)); focusBorder.SetValue(Border.CornerRadiusProperty, new CornerRadius(6)); focusBorder.SetValue(FrameworkElement.MarginProperty, new Thickness(-3));
   var focus = new Style(typeof(Control)); focus.Setters.Add(new Setter(Control.TemplateProperty, new ControlTemplate(typeof(Control)) { VisualTree = focusBorder })); style.Setters.Add(new Setter(Control.FocusVisualStyleProperty, focus));
   return style;
  }
  internal void SetIcon(ImageSource source) { icon.Source = source; }
  internal void SetRegistered(bool value) { registered = value; Mode.Text = value ? "更新 Codex Light" : "安装 Codex Light"; RefreshActions(); }
  internal void SetMessage(string message) { Status.Text = message; }
  internal void Log(string message) { Details.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + message + Environment.NewLine); Details.ScrollToEnd(); }
  internal void SetCancelAllowed(bool value) { cancelAllowed = value; Secondary.IsEnabled = value; Secondary.Content = value ? "取消" : "安装中…"; }
  internal void SetStage(SetupStage stage, string message) { Stage = stage; SetMessage(message); RefreshActions(); }
  void RefreshActions() {
   Primary.Visibility = Visibility.Visible;
   Primary.Content = Stage == SetupStage.Completed ? (restartRequired ? "完成" : "打开应用") : Stage == SetupStage.Failed || Stage == SetupStage.Cancelled ? "重试" : registered ? "更新" : "安装";
   Primary.IsEnabled = Stage != SetupStage.Checking && Stage != SetupStage.Installing;
   Change.IsEnabled = !registered && Stage != SetupStage.Installing && Stage != SetupStage.Checking && Stage != SetupStage.Completed;
   Secondary.Visibility = Stage == SetupStage.Completed && restartRequired ? Visibility.Collapsed : Visibility.Visible;
   Secondary.Content = Stage == SetupStage.Completed ? "完成" : "取消"; Secondary.IsEnabled = Stage != SetupStage.Installing || cancelAllowed;
   Note.Visibility = Stage == SetupStage.Completed ? Visibility.Collapsed : Visibility.Visible;
   Note.Text = registered ? "将保留现有设置和项目。" : "安装完成后，可从开始菜单打开。";
  }
  internal void BlockStartup(string message) { SetStage(SetupStage.Failed, message); Primary.Visibility = Visibility.Collapsed; Primary.IsEnabled = false; Change.IsEnabled = false; Secondary.Content = "关闭"; Note.Text = "安装已停止，尚未检查、下载或安装运行环境。"; Log(message); }
  internal void Complete(int code) { ExitCodePolicy.RequireSuccess(code, "Codex Light"); restartRequired = code == 3010 || code == 1641; SetStage(SetupStage.Completed, code == 1641 ? "安装完成，Windows 已开始重启。" : restartRequired ? "安装完成。请重启 Windows 后打开 Codex Light。" : "安装完成，Codex Light 已准备就绪。"); }
  internal static string ProgressSummary(string message) {
   int separator = message.IndexOf(" · ", StringComparison.Ordinal); string name = separator < 0 ? "" : message.Substring(0, separator) + " · ";
   if (message.Contains("下载官方依赖")) return name + "正在下载…";
   if (message.Contains("下载进度：")) return name + message.Substring(message.IndexOf("下载进度：", StringComparison.Ordinal));
   if (message.Contains("核验固定哈希")) return name + "正在验证下载文件…";
   if (message.Contains("正在安装已验证")) return name + "正在安装，请等待系统授权或安装完成…";
   return message.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
  }
 }
}
