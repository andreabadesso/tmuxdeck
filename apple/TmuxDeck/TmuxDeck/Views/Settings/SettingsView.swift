import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var settings: SettingsResponse?
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("Terminal") {
                HStack {
                    Text("Font Size")
                    Spacer()
                    Stepper(
                        "\(Int(appState.preferences.fontSize))pt",
                        value: Bindable(appState.preferences).fontSize,
                        in: 8...32,
                        step: 1
                    )
                }

                NavigationLink {
                    TerminalThemeView()
                } label: {
                    HStack {
                        Text("Theme")
                        Spacer()
                        Text(appState.preferences.currentTheme.name)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if KeychainService.shared.biometricsAvailable {
                Section("Security") {
                    let biometricName = KeychainService.shared.biometricType == .faceID
                        ? "Face ID" : "Touch ID"

                    Toggle("\(biometricName) Unlock", isOn: Bindable(appState.preferences).biometricsEnabled)

                    NavigationLink("Change PIN") {
                        ChangePINView()
                    }
                }
            } else {
                Section("Security") {
                    NavigationLink("Change PIN") {
                        ChangePINView()
                    }
                }
            }

            Section("Server") {
                if let server = appState.activeServer {
                    LabeledContent("Name", value: server.name)
                    LabeledContent("URL", value: server.url)
                }

                Button("Switch Server") {
                    appState.currentScreen = .serverSetup
                }
            }

            if let settings = settings {
                Section("Notifications") {
                    LabeledContent("Telegram Bot") {
                        Text(settings.telegramBotToken.isEmpty ? "Not configured" : "Configured")
                            .foregroundStyle(settings.telegramBotToken.isEmpty ? Color.secondary : Color.green)
                    }
                }
            }

            Section("Account") {
                Button("Logout") {
                    Task { await appState.logout() }
                }
                .foregroundStyle(.red)
            }

            Section("About") {
                LabeledContent("Version", value: "1.0.0")
                LabeledContent("TmuxDeck", value: "iOS Client")
            }
        }
        .navigationTitle("Settings")
        .task {
            await loadSettings()
        }
    }

    private func loadSettings() async {
        isLoading = true
        do {
            settings = try await appState.apiClient.getSettings()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
