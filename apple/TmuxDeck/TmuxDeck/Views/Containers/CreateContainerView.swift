import SwiftUI

struct CreateContainerView: View {
    let apiClient: APIClient
    var onCreated: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    @State private var templates: [TemplateResponse] = []
    @State private var selectedTemplate: TemplateResponse?
    @State private var containerName = ""
    @State private var envVars: [(key: String, value: String)] = []
    @State private var volumes: [String] = []
    @State private var newVolume = ""
    @State private var mountSsh = true
    @State private var mountClaude = true
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Template") {
                    if templates.isEmpty && isLoading {
                        ProgressView()
                    } else if templates.isEmpty {
                        Text("No templates available")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(templates) { template in
                            Button {
                                selectedTemplate = template
                                if containerName.isEmpty {
                                    containerName = template.name
                                }
                                envVars = template.defaultEnv.map { (key: $0.key, value: $0.value) }
                                volumes = template.defaultVolumes
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(template.name)
                                            .foregroundStyle(.primary)
                                        Text(template.type)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if selectedTemplate?.id == template.id {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.tint)
                                    }
                                }
                            }
                        }
                    }
                }

                Section("Container Name") {
                    TextField("Name", text: $containerName)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                Section("Options") {
                    Toggle("Mount SSH Keys", isOn: $mountSsh)
                    Toggle("Mount Claude Config", isOn: $mountClaude)
                }

                Section("Environment Variables") {
                    ForEach(envVars.indices, id: \.self) { index in
                        HStack {
                            TextField("Key", text: Binding(
                                get: { envVars[index].key },
                                set: { envVars[index].key = $0 }
                            ))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                            TextField("Value", text: Binding(
                                get: { envVars[index].value },
                                set: { envVars[index].value = $0 }
                            ))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        }
                    }
                    .onDelete { indices in
                        envVars.remove(atOffsets: indices)
                    }

                    Button("Add Variable") {
                        envVars.append((key: "", value: ""))
                    }
                }

                Section("Volume Mounts") {
                    ForEach(volumes, id: \.self) { volume in
                        Text(volume)
                            .font(.system(.caption, design: .monospaced))
                    }
                    .onDelete { indices in
                        volumes.remove(atOffsets: indices)
                    }

                    HStack {
                        TextField("/host:/container", text: $newVolume)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))

                        Button("Add") {
                            guard !newVolume.isEmpty else { return }
                            volumes.append(newVolume)
                            newVolume = ""
                        }
                        .disabled(newVolume.isEmpty)
                    }
                }

                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("New Container")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task { await createContainer() }
                    }
                    .disabled(selectedTemplate == nil || containerName.isEmpty || isLoading)
                }
            }
            .task { await loadTemplates() }
        }
    }

    private func loadTemplates() async {
        isLoading = true
        do {
            templates = try await apiClient.getTemplates()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func createContainer() async {
        guard let template = selectedTemplate else { return }
        isLoading = true
        error = nil

        var env: [String: String] = [:]
        for pair in envVars where !pair.key.isEmpty {
            env[pair.key] = pair.value
        }

        let request = CreateContainerRequest(
            templateId: template.id,
            name: containerName,
            env: env,
            volumes: volumes,
            mountSsh: mountSsh,
            mountClaude: mountClaude
        )

        do {
            _ = try await apiClient.createContainer(request)
            onCreated?()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
