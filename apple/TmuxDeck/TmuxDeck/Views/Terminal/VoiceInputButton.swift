import SwiftUI

struct VoiceInputButton: View {
    let onText: (String) -> Void
    @State private var speech = SpeechRecognitionService()
    @State private var isPressing = false
    @State private var hasPermission: Bool?
    @State private var showTranscript = false
    @State private var sentText = ""
    @State private var pulsePhase: CGFloat = 0
    @State private var showLanguagePicker = false
    @State private var pressStart: Date?

    var body: some View {
        ZStack(alignment: .bottom) {
            if showTranscript && !sentText.isEmpty {
                transcriptToast
                    .transition(.asymmetric(
                        insertion: .move(edge: .bottom).combined(with: .opacity),
                        removal: .opacity
                    ))
            }

            if isPressing && !speech.transcript.isEmpty {
                liveTranscript
                    .transition(.opacity)
            }

            micButtonWithBadge
        }
        .animation(.easeInOut(duration: 0.2), value: isPressing)
        .animation(.easeInOut(duration: 0.2), value: showTranscript)
        .sheet(isPresented: $showLanguagePicker) {
            LanguagePickerSheet(
                currentLocale: speech.locale,
                onSelect: { locale in
                    speech.locale = locale
                    showLanguagePicker = false
                }
            )
            .presentationDetents([.medium, .large])
        }
        .task {
            hasPermission = await speech.requestPermissions()
        }
    }

    // MARK: - Button + Language Badge

    private var micButtonWithBadge: some View {
        VStack(spacing: 6) {
            micButton
            languageBadge
        }
    }

    private var languageBadge: some View {
        Text(speech.languageCode)
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.ultraThinMaterial, in: Capsule())
    }

    // MARK: - Mic Button

    private var micButton: some View {
        ZStack {
            pulsingRings
            buttonCircle
            micIcon
        }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if pressStart == nil {
                        pressStart = Date()
                    }
                    if !isPressing, let start = pressStart, Date().timeIntervalSince(start) > 0.2 {
                        startRecording()
                    }
                }
                .onEnded { _ in
                    let wasQuickTap: Bool
                    if let start = pressStart {
                        wasQuickTap = Date().timeIntervalSince(start) < 0.25
                    } else {
                        wasQuickTap = true
                    }
                    pressStart = nil

                    if isPressing {
                        finishRecording()
                    } else if wasQuickTap {
                        showLanguagePicker = true
                    }
                }
        )
        .sensoryFeedback(.impact(weight: .medium), trigger: isPressing)
        .opacity(hasPermission == false ? 0.4 : 1)
        .disabled(hasPermission == false)
    }

    @ViewBuilder
    private var pulsingRings: some View {
        if isPressing {
            pulsingRing(index: 0)
            pulsingRing(index: 1)
            pulsingRing(index: 2)
        }
    }

    private func pulsingRing(index: Int) -> some View {
        let size: CGFloat = 56 + CGFloat(index) * 16 + pulsePhase * 6
        let opacity: Double = 0.15 - Double(index) * 0.04
        let scale: CGFloat = 1 + CGFloat(speech.audioLevel) * 0.3 * CGFloat(index + 1)
        return Circle()
            .stroke(Color.white.opacity(opacity), lineWidth: 1.5)
            .frame(width: size, height: size)
            .scaleEffect(scale)
    }

    private var buttonCircle: some View {
        Circle()
            .fill(isPressing ? Color.red : Color(.systemBackground))
            .frame(width: 52, height: 52)
            .shadow(color: .black.opacity(isPressing ? 0.4 : 0.2), radius: isPressing ? 12 : 6, y: 2)
            .overlay {
                if isPressing {
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [Color.red.opacity(0.3), Color.clear],
                                center: .center,
                                startRadius: 0,
                                endRadius: 26
                            )
                        )
                }
            }
    }

    private var micIcon: some View {
        Image(systemName: isPressing ? "waveform" : "mic.fill")
            .font(.system(size: isPressing ? 20 : 18, weight: .semibold))
            .foregroundStyle(isPressing ? .white : .primary)
            .symbolEffect(.variableColor.iterative, isActive: isPressing)
            .contentTransition(.symbolEffect(.replace))
    }

    // MARK: - Transcripts

    private var liveTranscript: some View {
        Text(speech.transcript)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
            .frame(maxWidth: 240)
            .lineLimit(2)
            .padding(.bottom, 76)
    }

    private var transcriptToast: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.caption)
            Text(sentText)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.bottom, 76)
    }

    // MARK: - Actions

    private func startRecording() {
        isPressing = true
        speech.startListening()
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
            pulsePhase = 1
        }
    }

    private func finishRecording() {
        let text = speech.stopListening()
        isPressing = false
        pulsePhase = 0

        guard !text.isEmpty else { return }

        sentText = text
        onText(text)

        showTranscript = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            showTranscript = false
        }
    }
}

// MARK: - Language Picker

struct LanguagePickerSheet: View {
    let currentLocale: Locale
    let onSelect: (Locale) -> Void
    @State private var search = ""

    private var locales: [Locale] {
        let all = SpeechRecognitionService.supportedLocales
        if search.isEmpty { return all }
        return all.filter { locale in
            displayName(for: locale).localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationStack {
            List(locales, id: \.identifier) { locale in
                languageRow(locale)
            }
            .searchable(text: $search, prompt: "Search languages")
            .navigationTitle("Language")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func languageRow(_ locale: Locale) -> some View {
        Button {
            onSelect(locale)
        } label: {
            HStack {
                Text(displayName(for: locale))
                    .foregroundStyle(.primary)
                Spacer()
                if locale.identifier == currentLocale.identifier {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .fontWeight(.semibold)
                }
            }
        }
    }

    private func displayName(for locale: Locale) -> String {
        Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier
    }
}
