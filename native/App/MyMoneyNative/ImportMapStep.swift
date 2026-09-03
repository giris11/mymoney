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
                Text(firstChoiceLabel).tag("")
                ForEach(model.context.choosableAccounts) { account in
                    Text("\(account.name) (\(account.currency))").tag(account.id)
                }
                // THE ROW THAT USED NOT TO EXIST, AND THE DEAD END IT REMOVES.
                // A plain bank CSV has no Account column: every row of it means
                // "the account this statement is for", and the file never says
                // which. On a book with no accounts the picker above was empty,
                // the requirement could not be satisfied, and the only live
                // control on the screen was the one that gave up. An account
                // can be NAMED here instead, and the import creates it.
                Text("Create an account for this file\u{2026}")
                    .tag(ImportWizardModel.newAccountTag)
            }
            if model.isNamingAnAccount { newAccountFields }
        } header: {
            Text("Import into")
        } footer: {
            // WHY THE CURRENCY IS MENTIONED HERE AT ALL. A transaction is
            // stored in its ACCOUNT's currency, never the file's (D30), and
            // choosing the account is the moment that is decided. Saying it
            // afterwards, in the preview, would be telling somebody what
            // happened rather than letting them choose it.
            Text(accountFooter)
        }
    }

    /// What the "no account pinned" row says, which depends on whether leaving
    /// it there is a workable answer at all.
    private var firstChoiceLabel: String {
        if model.mapping.account >= 0 { return "Use the file\u{2019}s own Account column" }
        return model.canChooseAnExistingAccount
            ? "Choose an account\u{2026}" : "No account chosen yet"
    }

    private var accountFooter: String {
        if model.mapping.account >= 0 {
            return "Optional. Choosing one overrides the file\u{2019}s Account column for "
                + "every row."
        }
        if model.isNamingAnAccount {
            return "This account does not exist yet \u{2014} the import creates it, and you can "
                + "still untick it on the next screen. Its currency fixes how its amounts are "
                + "read and how they are stored, so amounts with no Currency column are read as "
                + "\(model.mappingCurrency)."
        }
        if !model.canChooseAnExistingAccount {
            return "Your book has no accounts yet, so there is nothing to choose. Name one for "
                + "this file instead \u{2014} the import will create it \u{2014} or map an "
                + "Account column below if the file has one."
        }
        return "Required unless you map an Account column below. Amounts with no Currency "
            + "column are read as \(model.mappingCurrency), and every row is stored in its "
            + "account\u{2019}s currency."
    }

    /// Name and currency for an account this import would create.
    @ViewBuilder private var newAccountFields: some View {
        TextField("Account name", text: $model.newAccountName)
            #if os(iOS)
                .textInputAutocapitalization(.words)
            #endif
            .accessibilityLabel("New account name")
        TextField("Currency (e.g. GBP)", text: $model.newAccountCurrency)
            #if os(iOS)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            #endif
            .accessibilityLabel("New account currency")
        // SAID HERE AS WELL AS IN THE BAR. The bar's note is what stops the
        // primary action being a mystery; this one is beside the field that is
        // wrong, which is where somebody typing is actually looking.
        if let problem = model.newAccountProblem {
            Text(problem)
                .font(.footnote)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
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
                        // A debit/credit pair already carries its own direction
                        // -- the debit column IS the money out -- so flipping
                        // would invert a sign the file stated unambiguously.
                        // The toggle is therefore greyed, and SAYS SO here
                        // rather than sitting inert with an explanation that
                        // only exists in this comment.
                        Text(
                            signFlipLocked
                                ? "Not needed: you have mapped a Debit or Credit column, and "
                                    + "those already say which way the money went."
                                : "For an export that writes money out as a positive number."
                        )
                        .font(.caption)
                        .foregroundStyle(signFlipLocked ? Color.orange : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .disabled(signFlipLocked)
            }
        } footer: {
            Text(
                "Left to work it out, the reader decides from the whole column at once rather "
                    + "than row by row \u{2014} so one odd value cannot change how the rest are "
                    + "read."
            )
        }
    }

    /// Flipping signs is meaningless once a Debit/Credit pair is mapped.
    private var signFlipLocked: Bool {
        model.mapping.debit >= 0 || model.mapping.credit >= 0
    }

    // MARK: The bar

    private var bar: some View {
        ActionBar {
            // THE REASON IS THE BUTTON'S OWN NOW, drawn by `PrimaryAction`
            // immediately above itself -- one implementation for every bar in
            // the app, and a disabled primary that cannot be written without
            // one. See `ActionBar.swift`.
            PrimaryAction(
                title: model.busy ? "Reading the file\u{2026}" : "Preview the import",
                systemImage: "list.bullet.rectangle",
                disabledReason: previewProblem,
                probe: "Import \u{2014} Preview the import"
            ) {
                Task { await model.continueFromMap() }
            }
        }
    }

    private var previewProblem: PrimaryAction.DisabledReason? {
        if model.busy { return .working }
        // A WHOLE SENTENCE STANDS ALONE. Folding "Give the new account a
        // name..." into "Still needed: ..." produced a run-on with two full
        // stops -- the list is fragments, and this is not one of them.
        if let problem = model.newAccountProblem { return .because(problem) }
        let missing = model.missingRequirements
        guard !missing.isEmpty else { return nil }
        return .because("Still needed: " + missing.joined(separator: ", ") + ".")
    }
}
