using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Hydros.System.UI;

internal sealed class MainForm : Form
{
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly string initialFile;
    private string selectedIfc = "";
    private string pendingIfc = "";

    public MainForm(string[] args)
    {
        initialFile = args.FirstOrDefault(path => File.Exists(path) && Path.GetExtension(path).Equals(".ifc", StringComparison.OrdinalIgnoreCase)) ?? "";
        Text = "Hydros System — Dimensionador hidráulico";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1100, 700);
        WindowState = FormWindowState.Maximized;
        Controls.Add(browser);
        Load += InitializeBrowserAsync;
    }

    private async void InitializeBrowserAsync(object? sender, EventArgs e)
    {
        try
        {
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hydros System", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping("app.hydros", Path.Combine(AppContext.BaseDirectory, "Web"), CoreWebView2HostResourceAccessKind.DenyCors);
            core.AddWebResourceRequestedFilter("https://ifc.hydros/model.ifc", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += ServeSelectedIfc;
            core.WebMessageReceived += (_, message) =>
            {
                if (!Uri.TryCreate(message.Source, UriKind.Absolute, out var source) || source.Scheme != "https" || source.Host != "app.hydros") return;
                try
                {
                    using var json = JsonDocument.Parse(message.WebMessageAsJson);
                    if (!json.RootElement.TryGetProperty("type", out var type)) return;
                    switch (type.GetString())
                    {
                        case "openIfc": OpenIfc(); break;
                        case "modelAccepted" when pendingIfc.Length > 0: selectedIfc = pendingIfc; pendingIfc = ""; break;
                        case "modelRejected": pendingIfc = ""; break;
                    }
                }
                catch (JsonException) { Post(new { type = "error", text = "Mensagem inválida recebida pela interface." }); }
            };
            core.Navigate("https://app.hydros/index.html");
            if (initialFile.Length > 0)
            {
                selectedIfc = Path.GetFullPath(initialFile);
                browser.NavigationCompleted += (_, _) => PostFileSelected(selectedIfc);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(this, $"Não foi possível iniciar o visualizador WebView2.\n\n{error.Message}", "Hydros System", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OpenIfc()
    {
        using var dialog = new OpenFileDialog { Filter = "Modelos IFC (*.ifc)|*.ifc|Todos os arquivos (*.*)|*.*", Title = "Abrir modelo hidráulico IFC" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        pendingIfc = Path.GetFullPath(dialog.FileName);
        PostFileSelected(pendingIfc);
    }

    private void PostFileSelected(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) { if (path == pendingIfc) pendingIfc = ""; Post(new { type = "error", text = "O arquivo IFC selecionado não está disponível." }); return; }
        var identity = Path.GetFullPath(path).ToUpperInvariant() + "|" + info.Length + "|" + info.LastWriteTimeUtc.Ticks;
        var fileKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
        Post(new { type = "ifcSelected", name = info.Name, size = info.Length, modified = info.LastWriteTimeUtc, fileKey });
    }

    private void Post(object message)
    {
        if (InvokeRequired) { BeginInvoke(() => Post(message)); return; }
        browser.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }

    private void ServeSelectedIfc(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var core = browser.CoreWebView2;
        if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host != "ifc.hydros" || uri.AbsolutePath != "/model.ifc") return;
        var source = pendingIfc.Length > 0 ? pendingIfc : selectedIfc;
        if (source.Length == 0 || (e.Request.Method != "GET" && e.Request.Method != "HEAD"))
        {
            e.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", "Access-Control-Allow-Origin: https://app.hydros");
            return;
        }
        try
        {
            var info = new FileInfo(source);
            if (!info.Exists) throw new FileNotFoundException();
            var headers = $"Content-Type: application/octet-stream\r\nContent-Length: {info.Length}\r\nLast-Modified: {info.LastWriteTimeUtc:R}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: https://app.hydros\r\nAccess-Control-Expose-Headers: Last-Modified, Content-Length";
            Stream? body = e.Request.Method == "HEAD" ? null : new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read);
            e.Response = core.Environment.CreateWebResourceResponse(body, 200, "OK", headers);
        }
        catch (IOException)
        {
            e.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", "Access-Control-Allow-Origin: https://app.hydros");
        }
    }
}


