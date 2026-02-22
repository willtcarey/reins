import SwiftUI
import WebKit
import UserNotifications

struct ContentView: View {
    @ObservedObject var viewModel: WebViewModel

    var body: some View {
        WebView(viewModel: viewModel)
            .frame(minWidth: 800, minHeight: 600)
            .onAppear {
                viewModel.load()
            }
    }
}

class WebViewModel: ObservableObject {
    let webView: WKWebView

    init() {
        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        config.userContentController = contentController

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")

        self.webView = webView

        // JS-to-Swift bridge: window.webkit.messageHandlers.reins.postMessage({...})
        contentController.add(MessageHandler(), name: "reins")
    }

    /// Resolved backend URL.
    /// 1. Runtime env var `REINS_BACKEND_URL` (highest priority)
    /// 2. Compile-time build setting baked into Info.plist via `REINS_BACKEND_URL`
    /// 3. Default: http://localhost:3100
    var backendURL: URL {
        // Runtime override
        if let envURL = ProcessInfo.processInfo.environment["REINS_BACKEND_URL"],
           !envURL.isEmpty,
           let url = URL(string: envURL) {
            return url
        }
        // Compile-time setting from Info.plist
        if let plistURL = Bundle.main.object(forInfoDictionaryKey: "ReinsBackendURL") as? String,
           !plistURL.isEmpty,
           plistURL != "$(REINS_BACKEND_URL)",  // unexpanded variable means it wasn't set
           let url = URL(string: plistURL) {
            return url
        }
        // Default
        return URL(string: "http://localhost:3100")!
    }

    func load() {
        print("[Reins] Loading \(backendURL)")
        let request = URLRequest(url: backendURL)
        webView.navigationDelegate = navigationDelegate
        webView.load(request)
    }

    private let navigationDelegate = WebViewNavigationDelegate()

    func reload() {
        webView.reload()
    }
}

/// Handles messages sent from JS via window.webkit.messageHandlers.reins.postMessage(...)
class MessageHandler: NSObject, WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            print("[Reins] Unknown message: \(message.body)")
            return
        }

        switch action {
        case "notify":
            let title = body["title"] as? String ?? "Reins"
            let text = body["body"] as? String ?? ""
            sendNotification(title: title, body: text)
        default:
            print("[Reins] Unknown action: \(action)")
        }
    }

    private func sendNotification(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let request = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil
            )
            center.add(request)
        }
    }
}

class WebViewNavigationDelegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("[Reins] Page loaded: \(webView.url?.absoluteString ?? "unknown")")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("[Reins] Navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("[Reins] Provisional navigation failed: \(error.localizedDescription)")
    }
}

struct WebView: NSViewRepresentable {
    @ObservedObject var viewModel: WebViewModel

    func makeNSView(context: Context) -> WKWebView {
        return viewModel.webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
