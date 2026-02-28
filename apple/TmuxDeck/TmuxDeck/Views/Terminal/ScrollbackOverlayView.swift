import SwiftUI

struct ScrollbackOverlayView: View {
    let historyText: String
    let theme: TerminalTheme
    let fontSize: CGFloat
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            Color(theme.background)
                .ignoresSafeArea()

            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: true) {
                    VStack(spacing: 0) {
                        Text(attributedHistory)
                            .font(.system(size: fontSize, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)

                        Color.clear
                            .frame(height: 1)
                            .id("historyBottom")
                    }
                }
                .onAppear {
                    proxy.scrollTo("historyBottom", anchor: .bottom)
                }
            }

            // Dismiss button
            VStack {
                HStack {
                    Spacer()
                    Button {
                        onDismiss()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark")
                                .font(.system(size: 12, weight: .bold))
                            Text("Back to Live")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                    }
                    .padding(12)
                }
                Spacer()
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) {
            onDismiss()
        }
    }

    private var attributedHistory: AttributedString {
        let stripped = stripAnsiEscapes(historyText)
        var result = AttributedString(stripped)
        result.foregroundColor = Color(theme.foreground)
        return result
    }

    private func stripAnsiEscapes(_ text: String) -> String {
        var result = ""
        result.reserveCapacity(text.count)
        var i = text.startIndex
        while i < text.endIndex {
            let c = text[i]
            if c == "\u{1b}" {
                let next = text.index(after: i)
                if next < text.endIndex {
                    let nc = text[next]
                    if nc == "[" {
                        // CSI: skip until final byte (0x40-0x7E)
                        var j = text.index(after: next)
                        while j < text.endIndex {
                            let fc = text[j].asciiValue ?? 0
                            if fc >= 0x40 && fc <= 0x7E {
                                i = text.index(after: j)
                                break
                            }
                            j = text.index(after: j)
                        }
                        if j >= text.endIndex { i = text.endIndex }
                        continue
                    } else if nc == "]" {
                        // OSC: skip until ST (ESC\) or BEL
                        var j = text.index(after: next)
                        while j < text.endIndex {
                            if text[j] == "\u{07}" {
                                i = text.index(after: j)
                                break
                            }
                            if text[j] == "\u{1b}" {
                                let k = text.index(after: j)
                                if k < text.endIndex && text[k] == "\\" {
                                    i = text.index(after: k)
                                    break
                                }
                            }
                            j = text.index(after: j)
                        }
                        if j >= text.endIndex { i = text.endIndex }
                        continue
                    } else {
                        i = text.index(after: next)
                        continue
                    }
                }
            }
            result.append(c)
            i = text.index(after: i)
        }
        return result
    }
}
