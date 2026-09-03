// Step 2, for a generic CSV: which column is what.
//
// THE APP GUESSES AND HE CORRECTS, and the guess is `Import.guessMapping` --
// the same function the web app uses, held to the same oracle cases. What this
// screen adds is the ability to be wrong about it visibly: every column is
// listed with what it actually holds, so "Amount" pointing at a reference
// number is something you SEE rather than something you find out afterwards in
// your balances.
//
// A MONEYWIZ EXPORT NEVER GETS HERE. It names its own columns, so there is
// nothing to correct; it goes straight to the preview, where the one thing that
// CAN be ambiguous about it -- which way round its dates are -- is offered
// instead.
//
// WHAT THIS STEP WRITES: one mapping, into this device's own defaults, when the
// owner moves past it. Not into the book. See `ImportMapping.swift`.
import MyMoneyKit
import SwiftUI

struct ImportMapStep: View {
    @Bindable var model: ImportWizardModel

    var body: some View {
        List {
            if let note = model.mappingOrigin.note {
                Section {
                    ImportNote(text: note, symbol: "checkmark.circle", tone: .accentColor)
                }
            }

            accountSection
            columnsSection
            optionsSection

            if !model.parserWarnings.isEmpty {
                Section {
                    DisclosureGroup(Display.count(model.parserWarnings.count, "note")) {
                        ForEach(model.parserWarnings, id: \.self) { warning in
                            Text(warning)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } header: {
                    Text("What the reader noticed")
                }
            }

            if let problem = model.problem {
                Section {
                    ImportNote(text: problem, tone: .red)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { bar }
    }

    // MARK: Which account

    private var accountSection: some View {
        Section {
            Picker("Account", selection: $model.fixedAccountId) {
                Text(
                    model.mapping.account >= 0
                        ? "Use the file\u{2019}s own Account column" : "Choose an account\u{2026}"
                )
                .tag("")
                ForEach(model.context.choosableAccounts) { account in
                    Text("\(account.name) (\(account.currency))").tag(account.id)
                }
            }
        } header: {
            Text("Import into")
        } footer: {
            // WHY THE CURRENCY IS MENTIONED HERE AT ALL. A transaction is
            // stored in its ACCOUNT's currency, never the file's (D30), and
            // choosing the account is the moment that is decided. Saying it
            // afterwards, in the preview, would be telling somebody what
            // happened rather than letting them choose it.
            Text(
                model.mapping.account >= 0
                    ? "Optional. Choosing one overrides the file\u{2019}s Account column for "
                        + "every row."
                    : "Required unless you map an Account column below. Amounts with no Currency "
                        + "column are read as \(model.mappingCurrency), and every row is stored "
                        + "in its account\u{2019}s currency."
            )
        }
    }

    // MARK: The columns

    private var columnsSection: some View {
        Section {
            ForEach(0..<model.columnCount, id: \.self) { column in
                columnRow(column)
            }
        } header: {
            HStack {
                Text("Columns")
                Spacer()
                Text(Display.count(model.dataRowCount, "data row"))
                    .font(.caption)
                    .textCase(nil)
            }
        }
    }

    private func columnRow(_ column: Int) -> some View {
        // ViewThatFits rather than a fixed HStack: at a large accessibility
        // text size the name, two samples and a menu do not share a line, and a
        // truncated sample value is exactly the information this row exists to
        // show.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                columnDescription(column)
                Spacer(minLength: 8)
                fieldPicker(column)
            }
            VStack(alignment: .leading, spacing: 6) {
                columnDescription(column)
                fieldPicker(column)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func columnDescription(_ column: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(model.columnLabel(column))
                .font(.subheadline.weight(.medium))
            ForEach(Array(model.sampleRows().enumerated()), id: \.offset) { _, row in
                Text(sample(row, column))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func fieldPicker(_ column: Int) -> some View {
        Picker("Import as", selection: fieldBinding(column)) {
            Text("Ignore").tag(CSVField?.none)
            ForEach(CSVField.allCases) { field in
                Text(field.label).tag(CSVField?.some(field))
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .accessibilityLabel("Import \(model.columnLabel(column)) as")
    }

    private func sample(_ row: [String], _ column: Int) -> String {
        guard column < row.count else { return "\u{2014}" }
        let value = Names.clean(row[column])
        return value.isEmpty ? "\u{2014}" : value
    }

    /// A column maps to one field or to none, and setting it takes that column
    /// away from whatever field held it. See `CSVMapping.assign`.
    private func fieldBinding(_ column: Int) -> Binding<CSVField?> {
        Binding(
            get: { model.mapping.field(forColumn: column) },
            set: { model.mapping.assign(column: column, to: $0) }
        )
    }

    // MARK: How the file is read

    private var optionsSection: some View {
        Section {
            DisclosureGroup("How this file is read") {
                Picker("Dates", selection: $model.mapping.dateFormat) {
                    Text("Work it out").tag("auto")
                    Text("Day / Month / Year").tag("DMY")
                    Text("Month / Day / Year").tag("MDY")
                    Text("Year / Month / Day").tag("YMD")
                }
                Picker("Decimals", selection: $model.mapping.decimal) {
                    Text("Work it out").tag("auto")
                    Text("1,234.56").tag("dot")
                    Text("1.234,56").tag("comma")
                }
                Toggle("First row is column names", isOn: $model.mapping.headerRow)
                Toggle(isOn: $model.mapping.negate) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Flip the signs")
                        Text("For an export that writes money out as a positive number.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                // A debit/credit pair already carries its own direction -- the
                // debit column IS the money out -- so flipping would invert a
                // sign the file stated unambiguously.
                .disabled(model.mapping.debit >= 0 || model.mapping.credit >= 0)
            }
        } footer: {
            Text(
                "Left to work it out, the reader decides from the whole column at once rather "
                    + "than row by row \u{2014} so one odd value cannot change how the rest are "
                    + "read."
            )
        }
    }

    // MARK: The bar

    private var bar: some View {
        ActionBar {
            if !model.missingRequirements.isEmpty {
                ImportNote(
                    text: "Still needed: "
                        + model.missingRequirements.joined(separator: ", ") + ".",
                    symbol: "info.circle"
                )
            }
            PrimaryAction(
                title: model.busy ? "Reading the file\u{2026}" : "Preview the import",
                systemImage: "list.bullet.rectangle",
                isEnabled: !model.busy && model.missingRequirements.isEmpty
            ) {
                Task { await model.continueFromMap() }
            }
            .reachProbe("Import \u{2014} Preview the import")
        }
    }
}
