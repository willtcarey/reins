import SwiftUI

@main
struct ReinsApp: App {
    @StateObject private var webViewModel = WebViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: webViewModel)
        }
        .commands {
            CommandGroup(replacing: .newItem) { }
            CommandGroup(after: .toolbar) {
                Button("Reload Page") {
                    webViewModel.reload()
                }
                .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}
