// The fields every editor is built from.
//
// THEY ARE HERE, TOGETHER, FOR ONE REASON: an amount field written twice is two
// answers to "what did the owner type", and the second one will differ at the
// edges nobody tests -- a trailing space, a comma, a currency with no minor
// units. Every amount in this app is parsed by `Money.parseToMinor` and
// rendered by `Money.format`, both from the kit, both held to 284 oracle cases.
// No `NumberFormatter` is constructed anywhere in the app (Formatting.swift
// says so at length), and nothing below breaks that.
//
// THE SIGN IS A CONTROL, NOT A CHARACTER. Every amount field takes a POSITIVE
// magnitude and a direction -- "Money out" or "Money in" -- and the sign is
// applied by the app. A minus typed into a text field is invisible at a glance,
// survives a copy-paste from anywhere, and is the difference between a £400
// bill and a £400 refund. A segmented control is two words the eye reads
// without effort and cannot be off by a character.
import MyMoneyKit
import SwiftUI

// MARK: - Direction

/// Which way the money went. `Bool` would do and would be unreadable at every
/// call site.
enum MoneyDirection: String, CaseIterable, Identifiable, Sendable {
    case out, into

    var id: String { rawValue }

    var label: String { self == .out ? "Money out" : "Money in" }

    /// A magnitude, signed. The one place the sign is decided.
    func signed(_ magnitude: Int64) -> Int64 { self == .out ? -magnitude : magnitude }

    /// Which direction a stored signed amount is. Zero reads as "out", which is
    /// what a new expense with nothing typed yet should offer.
    static func of(_ signed: Int64) -> MoneyDirection { signed > 0 ? .into : .out }
}

// MARK: - The typed amount

/// An amount as the owner is typing it: the digits, and which way.
///
/// A VALUE RATHER THAN TWO @State VARIABLES, so that "is this a saveable
/// amount?" is asked in one place. `minor` is nil while the text is not yet a
/// number -- including while it is empty -- and a Save button that is disabled
/// on nil can never submit a half-typed figure.
struct TypedAmount: Equatable {
    var text: String = ""
    var direction: MoneyDirection = .out

    init(text: String = "", direction: MoneyDirection = .out) {
        self.text = text
        self.direction = direction
    }

    /// From a stored signed amount, for opening an editor on an existing row.
    init(signed: Int64, currency: String) {
        self.direction = MoneyDirection.of(signed)
        // `magnitude` rather than `abs`, which traps at Int64.min.
        self.text = Money.formatPlain(Int64(bitPattern: signed.magnitude), currency: currency)
    }

    func minor(currency: String) -> Int64? {
        guard let magnitude = Money.parseToMinor(text, currency: currency), magnitude >= 0
        else { return nil }
        return direction.signed(magnitude)
    }
}

/// A labelled amount row: the direction, the field, and the parsed figure read
/// back underneath so the owner can see what the app understood.
struct AmountField: View {
    let title: String
    let currency: String
    @Binding var amount: TypedAmount
    var showsDirection = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsDirection {
                Picker(title, selection: $amount.direction) {
                    ForEach(MoneyDirection.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Direction")
            }
            HStack {
                Text(title)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 12)
                TextField("0", text: $amount.text)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    #if os(iOS)
                        .keyboardType(.decimalPad)
                    #endif
                    .accessibilityLabel("\(title) in \(currency)")
            }
            // WHAT THE APP UNDERSTOOD, read back. The gap between what somebody
            // typed and what a parser made of it is where a wrong figure hides,
            // and it costs one quiet line to close it.
            if let minor = amount.minor(currency: currency) {
                Text(Display.money(minor, currency))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(amountColour(minor))
                    .accessibilityLabel("Reads as \(Display.moneySpoken(minor, currency))")
            } else if !amount.text.isEmpty {
                Text("Not an amount this app can read.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
    }
}

// MARK: - The keypad

/// The fast path's amount: a till, not a text field.
///
/// DIGITS ARE MINOR UNITS, so "3", "5", "0" is £3.50 with no decimal point to
/// find and no keyboard to switch. It is the pattern every card reader and
/// every good expense app uses, and it is the difference between logging a
/// coffee in three seconds and giving up.
///
/// The number of places comes from `Money.decimals(for:)`, so the same three
/// taps in JPY are ¥350 rather than ¥3.50 -- a currency with no minor units
/// gets no decimal point, rather than a wrong one.
///
/// IT IS IN TWO PIECES, WHICH IS A REACH DECISION rather than a tidiness one.
/// The FIGURE is read and the KEYS are pressed, and on a 6.9" phone those two
/// jobs want opposite ends of the screen: the figure belongs up where the eye
/// already is, and the keys belong in the bottom third with the Save button, so
/// that logging a coffee is one thumb from first digit to saved. Quick Add pins
/// `AmountKeypadKeys` into its bottom bar for exactly that reason. `AmountKeypad`
/// keeps the two together for anywhere that wants the whole thing in the flow.
enum AmountKeypad {
    /// The magnitude the digits currently mean. Capped while typing rather
    /// than allowed to overflow: 19 digits of pounds is not an amount anyone
    /// is entering, and a wrapped Int64 is a negative balance with no error.
    static func magnitude(_ digits: String) -> Int64 {
        Int64(digits.prefix(15)) ?? 0
    }
}

/// The figure, big, and which way it goes. Read, not pressed -- except for the
/// direction control, which is two taps a month rather than four a minute.
struct AmountKeypadReadout: View {
    let currency: String
    let digits: String
    @Binding var direction: MoneyDirection

    private var signed: Int64 { direction.signed(AmountKeypad.magnitude(digits)) }

    var body: some View {
        VStack(spacing: 14) {
            Text(Display.money(signed, currency))
                .font(.system(size: 44, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.4)
                .foregroundStyle(amountColour(signed))
                .frame(maxWidth: .infinity)
                .accessibilityLabel("Amount")
                .accessibilityValue(Display.moneyFlowSpoken(signed, currency))

            Picker("Direction", selection: $direction) {
                ForEach(MoneyDirection.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
        }
    }
}

/// The keys. Nothing else, so that a screen can put them wherever the thumb is.
struct AmountKeypadKeys: View {
    @Binding var digits: String

    var body: some View {
        Grid(horizontalSpacing: 10, verticalSpacing: 10) {
            ForEach([["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]], id: \.first) { row in
                GridRow {
                    ForEach(row, id: \.self) { key($0) }
                }
            }
            GridRow {
                // No decimal point: the digits ARE minor units. A key that
                // did nothing would be worse than no key.
                Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                key("0")
                Button {
                    if !digits.isEmpty { digits.removeLast() }
                } label: {
                    Image(systemName: "delete.left")
                        .frame(maxWidth: .infinity, minHeight: 52)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Delete last digit")
            }
        }
    }

    private func key(_ digit: String) -> some View {
        Button {
            // Leading zeros are dropped so "007" cannot become an amount that
            // reads differently from what is on screen.
            if digits.isEmpty && digit == "0" { return }
            if digits.count < 15 { digits.append(digit) }
        } label: {
            Text(digit)
                .font(.title2)
                .monospacedDigit()
                .frame(maxWidth: .infinity, minHeight: 52)
        }
        .buttonStyle(.bordered)
    }
}

// MARK: - Payee

/// A payee field that completes from what the book already contains, and offers
/// to fill in the category the payee is usually filed under.
///
/// CHOOSING A SUGGESTION IS THE SECOND OF THE THREE TAPS DISAPPEARING: the
/// category comes with it (D17, learned by `learnPayeeCategory`), so a coffee
/// is amount, payee, done. It only fills a category that is still EMPTY --
/// overwriting a category the owner has just chosen would be the app arguing
/// with them.
struct PayeeField: View {
    let index: PayeeIndex
    @Binding var name: String
    /// Set when a suggestion carries a learned category and the field is empty.
    @Binding var categoryId: String?
    var categoryName: (String) -> String?

    @FocusState private var focused: Bool

    private var suggestions: [PayeeSuggestion] {
        guard focused else { return [] }
        // An exact match is already what the field says; offering it back is a
        // row that does nothing.
        return index.suggestions(matching: name, limit: 6)
            .filter { Names.key($0.name) != Names.key(name) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Payee", text: $name)
                .focused($focused)
                #if os(iOS)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                #endif
                .accessibilityLabel("Payee")

            ForEach(suggestions) { suggestion in
                Button {
                    name = suggestion.name
                    if categoryId == nil { categoryId = suggestion.defaultCategoryId }
                    focused = false
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.up.left")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(suggestion.name)
                        if let learned = suggestion.defaultCategoryId,
                            let path = categoryName(learned)
                        {
                            Text("\u{00B7} \(path)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(
                    suggestion.defaultCategoryId.flatMap(categoryName)
                        .map { "Also sets the category to \($0)" } ?? "Uses this payee"
                )
            }

            if !name.isEmpty, index.exactMatch(name) == nil {
                // Creating a payee is fine; creating one because of a typo,
                // silently, is how an autocomplete list fills with near-misses.
                Text("New payee \u{2014} it will be added to your list.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Category

/// The category picker: the ones this book actually uses, then all of them,
/// searchable.
///
/// CHOOSING CLOSES IT. It used to set the binding and stay put, which left the
/// owner looking at a list with a tick in it and no signal that anything had
/// happened -- the natural readings are "that did not work" (so tap again) or
/// "there is more to do here" (so hunt for a Done button that does not exist).
/// Either way the way out was the back arrow at the top left of a 6.9" phone,
/// which is the hardest place on the screen to reach, for a screen whose work
/// was already finished.
///
/// A picker is a question. Answering it is the end of it.
struct CategoryPicker: View {
    let categories: [CategoryChoice]
    let frequentIds: [String]
    @Binding var selection: String?
    var allowsNone = true

    /// Pops this screen off whatever pushed it. Works for both callers: the
    /// `CategoryRow` in a form and the "All categories" link in Quick Add are
    /// both `NavigationLink`s, and `dismiss` in a pushed view pops rather than
    /// closing the sheet around it.
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var frequent: [CategoryChoice] {
        frequentIds.compactMap { id in categories.first { $0.id == id } }
    }

    private var matches: [CategoryChoice] {
        let key = Names.key(query)
        guard !key.isEmpty else { return categories }
        return categories.filter { Names.key($0.path).contains(key) }
    }

    var body: some View {
        List {
            if allowsNone {
                Button {
                    selection = nil
                    dismiss()
                } label: {
                    row(title: "No category", selected: selection == nil, depth: 0, archived: false)
                }
                .buttonStyle(.plain)
            }
            if query.isEmpty && !frequent.isEmpty {
                Section("Most used") {
                    ForEach(frequent) { choice in button(choice, showFullPath: true) }
                }
            }
            Section(query.isEmpty ? "All categories" : "Matches") {
                if matches.isEmpty {
                    Text("Nothing matches \u{201C}\(query)\u{201D}.")
                        .foregroundStyle(.secondary)
                }
                ForEach(matches) { choice in button(choice, showFullPath: !query.isEmpty) }
            }
        }
        .searchable(text: $query, prompt: "Search categories")
        .navigationTitle("Category")
    }

    private func button(_ choice: CategoryChoice, showFullPath: Bool) -> some View {
        Button {
            selection = choice.id
            dismiss()
        } label: {
            row(
                title: showFullPath ? choice.path : choice.name,
                selected: selection == choice.id,
                depth: showFullPath ? 0 : choice.depth,
                archived: choice.archived
            )
        }
        .buttonStyle(.plain)
    }

    private func row(title: String, selected: Bool, depth: Int, archived: Bool) -> some View {
        HStack {
            if depth > 0 {
                Spacer().frame(width: CGFloat(depth) * 16)
            }
            Text(title)
                .foregroundStyle(archived ? .secondary : .primary)
            if archived {
                // Archived categories stay pickable: an old transaction filed
                // under one has to remain editable.
                Text("Archived").font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            if selected {
                Image(systemName: "checkmark").foregroundStyle(.tint)
            }
        }
        .contentShape(Rectangle())
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// The row that opens the picker, showing what is chosen.
struct CategoryRow: View {
    let categories: [CategoryChoice]
    let frequentIds: [String]
    @Binding var selection: String?
    var label = "Category"
    var allowsNone = true

    var body: some View {
        NavigationLink {
            CategoryPicker(
                categories: categories, frequentIds: frequentIds, selection: $selection,
                allowsNone: allowsNone
            )
        } label: {
            HStack {
                Text(label)
                Spacer()
                Text(chosenName ?? "None")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
    }

    private var chosenName: String? {
        selection.flatMap { id in categories.first { $0.id == id }?.path }
    }
}

// MARK: - Date

/// A date field over a "YYYY-MM-DD" string.
///
/// THE MODEL KEEPS THE STRING, not a `Date`. A `Date` is an instant and an
/// instant has a timezone; a transaction dated the 1st that becomes the 31st of
/// the previous month when the phone is in Sydney is a real bug in real finance
/// apps, and it moves money between budget periods and tax years. The picker
/// needs a `Date`, so one is built in UTC for the picker's sake alone and the
/// string is written straight back.
struct CalendarDateField: View {
    let title: String
    @Binding var iso: String

    private static var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private var date: Date {
        guard let parsed = CalendarDate(iso: iso) else { return Date() }
        var components = DateComponents()
        components.year = parsed.year
        components.month = parsed.month
        components.day = parsed.day
        return Self.utc.date(from: components) ?? Date()
    }

    var body: some View {
        DatePicker(
            title,
            selection: Binding(
                get: { date },
                set: { newValue in
                    let parts = Self.utc.dateComponents([.year, .month, .day], from: newValue)
                    if let calendarDate = CalendarDate(
                        year: parts.year ?? 0, month: parts.month ?? 0, day: parts.day ?? 0
                    ) {
                        iso = calendarDate.iso
                    }
                }
            ),
            displayedComponents: .date
        )
        .environment(\.timeZone, TimeZone(identifier: "UTC")!)
    }
}

/// Today, as the device's calendar has it. A default, never a stored fact.
func todayISO() -> String {
    let parts = Calendar.current.dateComponents([.year, .month, .day], from: Date())
    return CalendarDate(
        year: parts.year ?? 2026, month: parts.month ?? 1, day: parts.day ?? 1
    )?.iso ?? "2026-01-01"
}

// MARK: - Accounts

/// An account picker that shows every account, with archived ones marked.
///
/// ARCHIVED ACCOUNTS ARE STILL IN THE LIST. They are not what a new entry
/// means, so they sort last -- but an old transaction in one has to remain
/// correctable, and a picker that hid them would make that impossible.
struct AccountPicker: View {
    let accounts: [Account]
    let title: String
    @Binding var selection: String

    var body: some View {
        Picker(title, selection: $selection) {
            ForEach(accounts) { account in
                Text(
                    account.archived
                        ? "\(account.name) (archived) \u{00B7} \(account.currency)"
                        : "\(account.name) \u{00B7} \(account.currency)"
                )
                .tag(account.id)
            }
        }
    }
}
