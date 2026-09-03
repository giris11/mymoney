// The import wizard: the screen a CSV now leads to.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REPLACED WHAT
//
// A statement used to reach a dead end. The app read it correctly -- "this is a
// spreadsheet or a bank statement, not a backup", the row count, the real
// column names -- and then said: bring these rows in using your web app, take a
// fresh backup, and import that here. Honest, and useless to somebody standing
// in a shop with a phone: the web app is on a computer in another room.
//
// So the file goes somewhere now. Four steps, and the third one is why the
// other three exist:
//
//   FILE     the import screen, which already describes what arrived
//   MAP      which column is what. Generic CSV only -- a MoneyWiz export names
//            its own columns, so there is nothing to correct
//   PREVIEW  what WOULD happen, in full, with every awkward thing named
//   DONE     what did happen, and the undo
//
// NOTHING IS WRITTEN BEFORE THE CONFIRMATION ON THE PREVIEW STEP. Backing out
// at any point leaves the book exactly as it was, because up to that point
// nothing has touched a database: the plan is a pure function of the file, a
// snapshot of the book, and the owner's answers.
//
// ─────────────────────────────────────────────────────────────────────────────
// CANCEL IS AT THE TOP, EVERY PRIMARY ACTION IS AT THE BOTTOM
//
// The same division `ActionBar.swift` argues for, and for the same measured
// reason: the navigation bar sits about six per cent down a 956pt screen, which
// is the one band a thumb cannot reach without the hand letting go. That is the
// right home for a button pressed once by mistake and the wrong home for
// Continue, Import and Done. Each step owns its own bottom bar; each bar's
// primary carries a `reachProbe`, so where they land is a measurement rather
// than a screenshot somebody took once.
import MyMoneyKit
import SwiftUI

struct ImportWizard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: ImportWizardModel

    @State private var confirmingDiscard = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                WizardSteps(
                    step: model.step, hasMapStep: model.layout == .generic,
                    fileName: model.fileName
                )
                Divider()
                content
            }
            .navigationTitle(title)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // ON THE DONE STEP THERE IS NOTHING TO CANCEL. The rows are
                    // in the book; the way out is the bar at the bottom, which
                    // offers both Done and the undo. A "Cancel" up here would
                    // read as "undo this", which it is not.
                    if model.step != .done {
                        Button("Cancel") {
                            if model.hasUnsavedWork { confirmingDiscard = true } else { dismiss() }
                        }
                    }
                }
            }
        }
        // A downward swipe must not eat an import that is half set up. It is
        // still dismissable -- Cancel asks, and answers.
        .interactiveDismissDisabled(model.hasUnsavedWork)
        .confirmationDialog(
            "Stop setting up this import?", isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Stop", role: .destructive) { dismiss() }
            Button("Keep going", role: .cancel) {}
        } message: {
            Text(
                "Nothing has been written to your book, so nothing is lost except the columns and "
                    + "decisions on this screen. The file stays on the import screen."
            )
        }
        .task { await model.start() }
        // The book has changed. Every screen that draws it is rebuilt from
        // `revision`, and the widget and the reminders are republished -- an
        // import that added three hundred transactions and left the home screen
        // showing yesterday's net worth would be the same dishonesty as a
        // banner that stopped counting.
        .onChange(of: model.outcome) { _, outcome in
            // NOT WHEN THIS IMPORT STARTED THE BOOK. Refreshing then flips
            // `AppModel.isFirstRun` false, and `RootView` replaces the whole
            // first-run flow -- including the screen this sheet is presented
            // from -- which would tear the Done step and its undo button off
            // the screen the instant the commit landed. `ImportView.wizardClosed`
            // does it when the sheet is dismissed instead.
            if let outcome, !outcome.createdTheBook { Task { await app.rowsImported() } }
        }
        .onChange(of: model.undone) { _, undone in
            // THE SAME EXEMPTION, for the same reason. Undoing an import that
            // created the book leaves the book behind (removal is a tombstone
            // save, and a book is not an import batch), so a refresh here would
            // still flip `isFirstRun` false and pull this sheet off the screen
            // in the middle of showing what was taken back.
            if undone != nil, model.outcome?.createdTheBook != true {
                Task { await app.rowsImported() }
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.step {
        case .map:
            ImportMapStep(model: model)
        case .preview:
            ImportPreviewStep(model: model)
        case .done:
            ImportDoneStep(model: model, close: { dismiss() })
        }
    }

    private var title: String {
        switch model.step {
        case .map: return "Columns"
        case .preview: return "Preview"
        case .done: return model.undone == nil ? "Imported" : "Undone"
        }
    }
}

// MARK: - Where we are

/// The four steps, with the one that is happening now named in full.
///
/// A ROW OF DOTS IS NOT ENOUGH ON A PHONE, and a row of four labels does not
/// fit at a large text size. So the dots carry the position and one line of
/// text carries the meaning: which step this is, and which file it is about.
/// The file name is here rather than repeated on every step -- it is the answer
/// to "what am I looking at", and it should be answerable without scrolling.
private struct WizardSteps: View {
    let step: ImportWizardStep
    let hasMapStep: Bool
    let fileName: String

    private var steps: [(key: ImportWizardStep?, label: String)] {
        var out: [(ImportWizardStep?, String)] = [(nil, "File")]
        if hasMapStep { out.append((.map, "Columns")) }
        out.append((.preview, "Preview"))
        out.append((.done, "Done"))
        return out
    }

    /// How far along we are, counting the File step as already done -- it is:
    /// the file has been chosen, which is what that step is for.
    private var currentIndex: Int {
        steps.firstIndex { $0.key == step } ?? 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                ForEach(steps.indices, id: \.self) { index in
                    Capsule()
                        .fill(
                            index <= currentIndex
                                ? AnyShapeStyle(.tint) : AnyShapeStyle(.quaternary)
                        )
                        .frame(height: 4)
                        .accessibilityHidden(true)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Step \(currentIndex + 1) of \(steps.count) \u{2014} \(steps[currentIndex].label)")
                    .font(.caption.weight(.medium))
                Text(fileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Step \(currentIndex + 1) of \(steps.count), \(steps[currentIndex].label), \(fileName)"
        )
    }
}

// MARK: - Pieces the three steps share

/// A count worth checking, drawn so it can be. The number first, at a size that
/// survives a glance, with the words under it.
struct ImportStat: View {
    let value: Int
    let label: String
    var tone: Tone = .neutral

    enum Tone { case neutral, good, warning, problem }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(Display.grouped(value))
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(colour)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Display.grouped(value)) \(label)")
    }

    private var colour: Color {
        switch tone {
        case .neutral: return .primary
        case .good: return .green
        case .warning: return .orange
        case .problem: return .red
        }
    }
}

/// A sentence about something awkward, in the colour of how awkward it is.
struct ImportNote: View {
    let text: String
    var symbol = "exclamationmark.triangle"
    var tone: Color = .orange

    var body: some View {
        Label {
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol).foregroundStyle(tone)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A small word beside a name. Never the only signal: the word carries the
/// meaning and the colour is emphasis on top of it.
struct ImportChip: View {
    let text: String
    var tone: Color = .secondary

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tone.opacity(0.15), in: Capsule())
            .foregroundStyle(tone)
    }
}
