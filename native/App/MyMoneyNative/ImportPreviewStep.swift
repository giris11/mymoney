// Step 3 — the preview, which is the point of the whole wizard.
//
// ─────────────────────────────────────────────────────────────────────────────
// NUMBERS HE CAN CHECK AGAINST THE FILE, NOT A REASSURING SUMMARY
//
// This screen has one job: to make the import knowable BEFORE it happens. Every
// figure on it is derived from the plan's own rows -- the same rows the commit
// will write -- so anything it promises is something the write actually does.
//
// What it shows, in the order it shows it, and why that order:
//
//   1. THE COUNTS. Rows in the file, how many will be added, how many are
//      already in the book, how many need a decision, how many could not be
//      read. Five numbers that add up to the file's row count, so they can be
//      held against the file itself.
//   2. WHERE THE MONEY GOES. One line per account, in the file's own order:
//      how many transactions land in it, their sum, how many of its rows are
//      being skipped, and -- for an export that states balances -- whether the
//      account ends up on the figure the file says it should.
//   3. WHAT WILL BE CREATED, with the accounts tickable: unticking one drops
//      its rows from the import, and the counts above move as it is ticked.
//   4. THE AWKWARD THINGS, said out loud rather than buried: currency
//      mismatches, unpaired transfer legs, opening balances that will NOT be
//      applied because the account is already here.
//   5. THE NEAR-DUPLICATES, one card each, the incoming row beside the
//      transaction it resembles. Skipped unless he says otherwise; never
//      resolved automatically.
//   6. THE ROWS THAT COULD NOT BE READ, with their row numbers and the reason.
//   7. THE ROWS THEMSELVES.
//
// NOTHING HAS BEEN WRITTEN AT THIS POINT AND THE SCREEN SAYS SO. The only call
// that writes is behind the bar at the bottom and behind a confirmation that
// states what it is about to do.
import MyMoneyKit
import SwiftUI

struct ImportPreviewStep: View {
    let model: ImportWizardModel

    /// A file that failed wholesale -- one column mapped wrongly -- has an
    /// error per row. Drawing thirty thousand of them locks the phone at the
    /// exact moment they need reading, so every list here is capped and says
    /// how many it did not draw.
    private static let errorCap = 50
    private static let nearDuplicateCap = 50
    private static let rowCap = 200

    @State private var confirming = false

    var body: some View {
        Group {
            if let plan = model.plan {
                list(plan)
            } else if model.busy {
                ProgressView("Reading the file\u{2026}")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Notice(
                    symbol: "exclamationmark.triangle",
                    title: "This file could not be read",
                    message: model.problem
                        ?? "Nothing in it looked like rows of transactions. Nothing was changed.",
                    tone: .problem
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let plan = model.plan { bar(plan) }
        }
    }

    private func list(_ plan: ImportPlan) -> some View {
        List {
            countsSection(plan)
            if model.layout.isMoneyWiz { dateSection }
            accountsSection(plan)
            createSection(plan)
            disclosuresSection(plan)
            nearDuplicatesSection(plan)
            errorsSection(plan)
            rowsSection(plan)
        }
    }

    // MARK: 1. The counts

    private func countsSection(_ plan: ImportPlan) -> some View {
        Section {
            // Two rows of stats rather than a wrapping flow: the numbers are
            // meant to be compared, and a column of them at a fixed position is
            // easier to compare than a paragraph of chips.
            HStack(alignment: .top, spacing: 12) {
                ImportStat(value: plan.rowsRead, label: "rows in the file")
                ImportStat(
                    value: plan.importableCount, label: "will be added",
                    tone: plan.importableCount > 0 ? .good : .warning
                )
            }
            HStack(alignment: .top, spacing: 12) {
                ImportStat(value: plan.exactDuplicateCount, label: "already in your book")
                ImportStat(
                    value: plan.nearDuplicateCount, label: "need your decision",
                    tone: plan.nearDuplicateCount > 0 ? .warning : .neutral
                )
                ImportStat(
                    value: plan.errorCount, label: "could not be read",
                    tone: plan.errorCount > 0 ? .problem : .neutral
                )
            }
            if plan.errorCount > 0 && plan.errorCount == plan.rowsRead {
                ImportNote(
                    text: wholeFileFailedNote,
                    symbol: "exclamationmark.octagon", tone: .red
                )
            }
        } header: {
            Text(model.layout.headline)
        } footer: {
            Text(
                "Nothing has been written to your book yet. These five numbers add up to the "
                    + "rows in the file, so they can be checked against it."
            )
        }
    }

    /// Every single row failed, which is almost never a file full of bad rows
    /// and almost always one column read the wrong way.
    private var wholeFileFailedNote: String {
        switch model.layout {
        case .generic:
            return "Every row failed the same way, which usually means one column is mapped to "
                + "the wrong thing. Go back to Columns and check the Date and Amount rows against "
                + "the sample values shown beside them."
        case .moneyWizFlat, .moneyWizReport:
            return "Every row failed the same way, which usually means the dates are being read "
                + "the wrong way round. Try changing how dates are read, above."
        }
    }

    // MARK: 2. How the dates were read (MoneyWiz only)

    @ViewBuilder private var dateSection: some View {
        Section {
            Picker("Dates read as", selection: dateOrderBinding) {
                Text("Day / Month / Year").tag(DateOrder.dmy)
                Text("Month / Day / Year").tag(DateOrder.mdy)
                Text("Year / Month / Day").tag(DateOrder.ymd)
            }
            .disabled(model.busy)
            if let example = model.dateExample {
                FigureRow(
                    label: "\u{201C}\(example.raw)\u{201D} in this file is",
                    value: example.spelled
                )
            }
        } header: {
            Text("Dates")
        } footer: {
            // WHY THIS IS OFFERED AT ALL. A column where every value is 12 or
            // less is genuinely ambiguous -- 03/04 is the third of April or the
            // fourth of March, and nothing in the file says which. The reader
            // picks day-first; if that is wrong, every date in the import is
            // transposed, and this is the only place to say so.
            Text(
                "A date like 03/04 could be either way round, and this file may not say which. "
                    + "The example above is one of its own dates, spelled out. Changing this "
                    + "re-reads the whole file, so any decisions below start again."
            )
        }
    }

    private var dateOrderBinding: Binding<DateOrder> {
        Binding(
            get: { model.dateOrder },
            set: { order in Task { await model.setDateOrder(order) } }
        )
    }

    // MARK: 3. Where the money goes

    @ViewBuilder private func accountsSection(_ plan: ImportPlan) -> some View {
        let lines = ImportPreview.accountLines(
            plan: plan, context: model.context, reportAccounts: model.reportAccounts
        )
        if !lines.isEmpty {
            Section {
                ForEach(lines) { line in
                    AccountLineRow(line: line)
                }
            } header: {
                Text("Into which accounts")
            } footer: {
                if model.layout == .moneyWizReport {
                    Text(
                        "This layout states a closing balance for each account, so each new "
                            + "account\u{2019}s opening balance is worked out from it \u{2014} "
                            + "stated balance minus that account\u{2019}s own rows. The "
                            + "difference column is what would be left over; zero means the "
                            + "account lands exactly where the file says."
                    )
                } else {
                    Text(
                        "Sums are in each account\u{2019}s own currency, because that is the "
                            + "currency every row landing in it will be stored in."
                    )
                }
            }
        }
    }

    // MARK: 4. What will be created

    @ViewBuilder private func createSection(_ plan: ImportPlan) -> some View {
        if !plan.newAccounts.isEmpty {
            Section {
                ForEach(plan.newAccounts, id: \.name) { account in
                    Toggle(isOn: createBinding(account.name)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.name)
                            Text(openingLine(account))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text(Display.count(plan.newAccounts.count, "account") + " to create")
            } footer: {
                Text(
                    "An account you untick is not created, and none of its rows is imported "
                        + "\u{2014} the counts above move as you tick."
                )
            }
        }

        if !plan.newCategoryPaths.isEmpty || !plan.newPayees.isEmpty || !plan.newTags.isEmpty {
            Section {
                if !plan.newCategoryPaths.isEmpty {
                    NameList(
                        title: "Categories",
                        names: plan.newCategoryPaths.map { $0.joined(separator: " \u{203A} ") }
                    )
                }
                if !plan.newPayees.isEmpty {
                    NameList(title: "Payees", names: plan.newPayees)
                }
                if !plan.newTags.isEmpty {
                    NameList(title: "Tags", names: plan.newTags)
                }
            } header: {
                Text("Also created")
            } footer: {
                // FAITHFUL TO THE ENGINE, AND WORTH SAYING. These lists are
                // collected before the duplicate pass, so they include names
                // belonging only to rows that end up skipped. The commit
                // filters again at write time and creates only what a written
                // row actually needs, so this is an upper bound rather than a
                // promise.
                Text(
                    "At most these \u{2014} anything a skipped row was the only user of is not "
                        + "created."
                )
            }
        }
    }

    private func openingLine(_ account: NewAccountPlan) -> String {
        guard let opening = account.openingBalanceMinor else {
            return "\(account.currency) \u{2014} starts at zero, because the file does not state "
                + "a balance for it"
        }
        return "\(account.currency) \u{2014} opening balance "
            + Display.money(opening, account.currency)
    }

    /// READ THROUGH THE MODEL, NOT THROUGH THE PLAN THIS FUNCTION WAS HANDED.
    /// `ImportPlan` is a value: the copy passed into a view function is the one
    /// as it was when the body ran, and a getter closing over it would keep
    /// answering with the state before the owner's last tap. The model holds
    /// the live one.
    private func createBinding(_ name: String) -> Binding<Bool> {
        let key = Names.key(name)
        return Binding(
            get: { model.plan?.newAccounts.first { Names.key($0.name) == key }?.create ?? false },
            set: { model.setCreateAccount(named: name, $0) }
        )
    }

    // MARK: 5. The awkward things

    @ViewBuilder private func disclosuresSection(_ plan: ImportPlan) -> some View {
        let currency = ImportPreview.currencyMismatchNote(plan.currencyMismatchCount)
        let unpaired = ImportPreview.unpairedTransferNote(plan.unpairedTransferCount)
        let existing = ImportPreview.existingOpeningBalanceNote(
            plan.existingAccountsWithOpeningBalance
        )
        let ambiguous = plan.ambiguousScaleCount
        if currency != nil || unpaired != nil || existing != nil || ambiguous > 0
            || !model.parserWarnings.isEmpty
        {
            Section {
                if let currency { ImportNote(text: currency, symbol: "coloncurrencysign.circle") }
                if let unpaired { ImportNote(text: unpaired, symbol: "arrow.left.arrow.right") }
                if let existing { ImportNote(text: existing, symbol: "building.columns") }
                if ambiguous == 1 {
                    ImportNote(
                        text: "1 row states an amount this app cannot re-read at its "
                            + "account\u{2019}s own scale, so it is refused rather than written "
                            + "at a number that might be a hundred times wrong.",
                        tone: .red
                    )
                } else if ambiguous > 1 {
                    ImportNote(
                        text: "\(Display.count(ambiguous, "row")) state amounts this app cannot "
                            + "re-read at their accounts\u{2019} own scales, so they are refused "
                            + "rather than written at numbers that might be a hundred times "
                            + "wrong.",
                        tone: .red
                    )
                }
                if !model.parserWarnings.isEmpty {
                    DisclosureGroup(
                        Display.count(model.parserWarnings.count, "note") + " about the file"
                    ) {
                        ForEach(model.parserWarnings, id: \.self) { warning in
                            Text(warning)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            } header: {
                Text("Worth knowing before you import")
            }
        }
    }

    // MARK: 6. Near-duplicates

    @ViewBuilder private func nearDuplicatesSection(_ plan: ImportPlan) -> some View {
        let rows = plan.rows.enumerated().filter { $0.element.action == .needsDecision }
        if !rows.isEmpty {
            Section {
                HStack(spacing: 12) {
                    Button("Skip all") { model.decideAll(.skip) }
                        .buttonStyle(.bordered)
                    Button("Import all") { model.decideAll(.add) }
                        .buttonStyle(.bordered)
                    Spacer()
                }
                ForEach(rows.prefix(Self.nearDuplicateCap), id: \.offset) { index, row in
                    NearDuplicateCard(
                        row: row, index: index, context: model.context,
                        decide: { model.setDecision($0, forRowAt: index) }
                    )
                }
                if rows.count > Self.nearDuplicateCap {
                    Text(
                        "\u{2026}and \(Display.grouped(rows.count - Self.nearDuplicateCap)) more. "
                            + "Use the two buttons above to answer them all at once."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            } header: {
                Text("Your call \u{2014} \(Display.count(rows.count, "near-duplicate"))")
            } footer: {
                Text(
                    "These look like transactions you already have: same amount, a date within a "
                        + "day, a similar payee. They are skipped unless you say otherwise."
                )
            }
        }
    }

    // MARK: 7. Rows that could not be read

    @ViewBuilder private func errorsSection(_ plan: ImportPlan) -> some View {
        let problems = plan.problems
        if !problems.isEmpty {
            Section {
                ForEach(problems.prefix(Self.errorCap), id: \.rowNumber) { problem in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Row \(problem.rowNumber)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        Text(problem.reason)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
                if problems.count > Self.errorCap {
                    Text(
                        "\u{2026}and \(Display.grouped(problems.count - Self.errorCap)) more."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            } header: {
                Text("\(Display.count(problems.count, "row")) could not be read")
            } footer: {
                // THE HONEST HALF OF A PARTLY-UNREADABLE FILE. The rest of the
                // file still imports; these rows are named with their line
                // numbers so they can be found and fixed in the original, and
                // the file re-imported -- which adds only what is missing,
                // because everything already here is matched as a duplicate.
                Text(
                    "A row number counts the rows UNDER the header, from 1, ignoring blank "
                        + "lines. The rest of the file still imports; fix these in the file and "
                        + "bring it back, and only the missing ones will be added \u{2014} "
                        + "everything already here is matched and skipped."
                )
            }
        }
    }

    // MARK: 8. The rows

    @ViewBuilder private func rowsSection(_ plan: ImportPlan) -> some View {
        Section {
            ForEach(plan.rows.prefix(Self.rowCap), id: \.rowNumber) { row in
                PlanRowLine(row: row, plan: plan, context: model.context)
            }
            if plan.rows.count > Self.rowCap {
                Text("\u{2026}and \(Display.grouped(plan.rows.count - Self.rowCap)) more rows.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Every row")
        }
    }

    // MARK: The bar, and the one confirmation

    private func bar(_ plan: ImportPlan) -> some View {
        ActionBar {
            if let problem = model.problem {
                ImportNote(text: problem, tone: .red)
            }
            // A DISABLED PRIMARY WITH NOTHING BESIDE IT IS A DEAD END, which is
            // the thing this whole screen replaced. Nought to import has three
            // causes and they are not the same news: the file is already in the
            // book (good, and the commonest -- it is what re-importing the same
            // statement looks like), every row failed (fixable, and the counts
            // above say how), or the owner has unticked everything.
            if let note = nothingToImportNote(plan) {
                ImportNote(text: note, symbol: "info.circle", tone: .secondary)
            }
            HStack(spacing: 16) {
                if model.layout == .generic {
                    Button { model.back() } label: {
                        Label("Columns", systemImage: "chevron.left")
                            .frame(minHeight: 24)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(model.busy)
                }
                PrimaryAction(
                    title: primaryTitle(plan),
                    systemImage: "tray.and.arrow.down",
                    isEnabled: !model.busy && plan.importableCount > 0
                ) {
                    confirming = true
                }
                .reachProbe("Import \u{2014} Import these transactions")
            }
        }
        .confirmationDialog(
            "Add these to your book?", isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("Import \(Display.count(plan.importableCount, "transaction"))") {
                Task { await model.commit() }
            }
            Button("Not yet", role: .cancel) {}
        } message: {
            Text(confirmation(plan))
        }
    }

    private func nothingToImportNote(_ plan: ImportPlan) -> String? {
        guard plan.importableCount == 0, plan.rowsRead > 0 else { return nil }
        if plan.errorCount == plan.rowsRead { return nil }  // the counts already say it
        if plan.exactDuplicateCount + plan.nearDuplicateCount == plan.rowsRead {
            return "Every row in this file is already in your book, so there is nothing to add. "
                + "That is what bringing the same statement back a second time looks like."
        }
        if plan.accountsToCreateCount == 0 && !plan.newAccounts.isEmpty {
            return "Nothing will be added because every account this file needs is unticked "
                + "above."
        }
        return "Nothing in this file would be added. The counts above say why."
    }

    private func primaryTitle(_ plan: ImportPlan) -> String {
        if model.busy { return "Importing\u{2026}" }
        if plan.importableCount == 0 { return "Nothing to import" }
        return "Import \(Display.count(plan.importableCount, "transaction"))"
    }

    private func confirmation(_ plan: ImportPlan) -> String {
        var sentence =
            "\(Display.count(plan.importableCount, "transaction")) will be added to the copy of "
            + "your book on this device"
        if plan.accountsToCreateCount > 0 {
            sentence += ", and \(Display.count(plan.accountsToCreateCount, "account")) created"
        }
        sentence += ". Nothing already in your book is changed or removed, and the whole import "
        sentence += "can be undone straight afterwards."
        return sentence
    }
}

// MARK: - One account's line

private struct AccountLineRow: View {
    let line: ImportAccountLine

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(line.name)
                    .font(.subheadline.weight(.medium))
                statusChip
                Spacer(minLength: 8)
                Text(Display.money(line.importedNetMinor, line.currency))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(amountColour(line.importedNetMinor))
            }
            Text(countLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let balanceLine {
                Text(balanceLine)
                    .font(.caption)
                    .foregroundStyle(line.matchesFile ? Color.green : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken)
    }

    @ViewBuilder private var statusChip: some View {
        switch line.status {
        case .existing:
            EmptyView()
        case .willCreate:
            ImportChip(text: "new", tone: .accentColor)
        case .notCreated:
            ImportChip(text: "not created", tone: .secondary)
        case .untouched:
            ImportChip(text: "nothing to add", tone: .secondary)
        }
    }

    private var countLine: String {
        var parts = [Display.count(line.importedCount, "transaction")]
        if line.skippedCount > 0 { parts.append("\(Display.grouped(line.skippedCount)) skipped") }
        return parts.joined(separator: ", ")
    }

    /// The claim only a balance-stating export can make, and the one worth
    /// reading before committing: where this account ends up, against where the
    /// file says it should be.
    private var balanceLine: String? {
        guard let final = line.finalMinor, let stated = line.fileBalanceMinor,
            let difference = line.differenceMinor
        else {
            if line.status == .willCreate && line.fileOpeningMinor == nil
                && line.fileBalanceMinor != nil
            {
                return "The file states a balance for this account, but one of its rows could "
                    + "not be read \u{2014} so it is created at zero rather than at a guess."
            }
            return nil
        }
        if difference == 0 {
            return "Ends at \(Display.money(final, line.currency)) \u{2014} exactly what the file "
                + "states."
        }
        return "Ends at \(Display.money(final, line.currency)); the file states "
            + "\(Display.money(stated, line.currency)) \u{2014} "
            + "\(Display.money(difference, line.currency)) out."
    }

    private var spoken: String {
        var text = "\(line.name), \(countLine), net "
        text += Display.moneySpoken(line.importedNetMinor, line.currency)
        if let balanceLine { text += ". " + balanceLine }
        return text
    }
}

/// A list of names behind a disclosure, capped.
private struct NameList: View {
    let title: String
    let names: [String]
    private static let cap = 40

    var body: some View {
        DisclosureGroup("\(title) \u{2014} \(Display.grouped(names.count))") {
            ForEach(names.prefix(Self.cap), id: \.self) { name in
                Text(name)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if names.count > Self.cap {
                Text("\u{2026}and \(Display.grouped(names.count - Self.cap)) more.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - One near-duplicate, as a decision

private struct NearDuplicateCard: View {
    let row: ImportPlanRow
    let index: Int
    let context: ImportContext
    let decide: (ImportDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            side(
                caption: "From the file, row \(row.rowNumber)",
                date: row.row.date,
                title: row.row.payeeName ?? row.row.description ?? "\u{2014}",
                amount: row.amountMinor,
                currency: row.resolvedCurrency ?? context.baseCurrency,
                account: nil
            )
            Divider()
            side(
                caption: "Already in your book",
                date: row.nearDuplicateOf?.date,
                title: existingTitle,
                amount: row.nearDuplicateOf?.amountMinor,
                currency: row.nearDuplicateOf?.currency ?? context.baseCurrency,
                account: row.nearDuplicateOf.flatMap { context.accountName($0.accountId) }
            )
            Picker("Row \(row.rowNumber)", selection: decisionBinding) {
                Text("Skip it").tag(ImportDecision.skip)
                Text("Import anyway").tag(ImportDecision.add)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(.vertical, 4)
    }

    private var existingTitle: String {
        guard let existing = row.nearDuplicateOf else { return "\u{2014}" }
        if let payeeId = existing.payeeId, let name = context.payeeNameById[payeeId] {
            return name
        }
        return existing.notes.isEmpty ? "\u{2014}" : existing.notes
    }

    private var decisionBinding: Binding<ImportDecision> {
        Binding(get: { row.decision ?? .skip }, set: { decide($0) })
    }

    private func side(
        caption: String, date: String?, title: String, amount: Int64?, currency: String,
        account: String?
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let amount {
                    Text(Display.money(amount, currency))
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(amountColour(amount))
                }
            }
            HStack(spacing: 6) {
                if let date { Text(Display.dateText(date)) }
                if let account { Text("\u{00B7} \(account)") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - One row of the file

private struct PlanRowLine: View {
    let row: ImportPlanRow
    let plan: ImportPlan
    let context: ImportContext

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(row.rowNumber)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(minWidth: 24, alignment: .trailing)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if let date = row.row.date {
                        Text(Display.dateText(date))
                    } else {
                        Text("no date")
                    }
                    if let status = ImportPreview.statusLabel(row, in: plan) {
                        Text("\u{00B7}")
                        Text(status.text).foregroundStyle(colour(status.tone))
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            amountText
        }
        .opacity(row.isImportable ? 1 : 0.55)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        row.row.payeeName ?? row.row.description ?? row.row.notes ?? "\u{2014}"
    }

    @ViewBuilder private var amountText: some View {
        // AN ERROR ROW SHOWS NO FIGURE. Its amount was cleared by the planner
        // precisely because the number could not be trusted -- printing the
        // parser's earlier guess beside the word "error" would be offering a
        // figure this app has just refused to write.
        if row.action == .error {
            Text("\u{2014}").foregroundStyle(.tertiary)
        } else if let amount = row.amountMinor {
            Text(Display.money(amount, row.resolvedCurrency ?? context.baseCurrency))
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(amountColour(amount))
        } else {
            Text("\u{2014}").foregroundStyle(.tertiary)
        }
    }

    private func colour(_ tone: ImportPreview.RowTone) -> Color {
        switch tone {
        case .muted: return .secondary
        case .warning: return .orange
        case .problem: return .red
        case .accent: return .accentColor
        }
    }
}
