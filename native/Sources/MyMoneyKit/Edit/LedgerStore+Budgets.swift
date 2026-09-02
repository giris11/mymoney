// Budgets: create, edit, archive, delete, undo -- ported from `saveBudget` and
// `deleteBudget` in src/domain/budgets.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE DELIBERATE DEPARTURE FROM THE WEB APP, AND IT IS THE IMPORTANT ONE.
//
// The browser hard-deletes a budget, and says why: "Nothing references budgets,
// so a hard delete is safe." That is true about referential integrity and
// beside the point here. THIS APP NEVER HARD-DELETES ANYTHING. The rule is
// structural rather than a habit -- every read goes through a `live_*` view, so
// a tombstoned row is invisible everywhere without a single call site
// remembering to filter -- and a table that opted out would be the one place a
// mistake is unrecoverable. So `deleteBudget` writes a tombstone and hands back
// a `DeletedRecord`, which is what makes the undo bar honest: nothing was
// destroyed, so bringing it back is clearing a flag rather than rebuilding a
// row from a copy that might be stale.
//
// The consequence to keep in mind: a deleted budget is still in the file this
// copy would export, as a row with a `deletedAt`. That is the same treatment
// every other deleted record gets here.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE VALIDATION IS THE TYPESCRIPT'S, refusal for refusal:
//   * a name that is blank once trimmed is refused;
//   * an amount that is not a positive whole number of minor units is refused
//     -- a budget of nothing is not a limit, it is a mistake;
//   * at least one category, with duplicates collapsed;
//   * a start date that is a real calendar day (2026-02-30 is refused, never
//     rolled forward into March -- rolling it would move every window of the
//     grid by a day and the owner would never see why).
//
// AND ONE CHECK THE WEB APP DOES NOT MAKE: the category ids are verified to
// exist. In the browser a budget over a deleted category is merely useless; in
// a copy that was imported from a file, a category id that names nothing is
// more likely a typo in a restore than a deliberate choice, and
// `Categories.descendantIds` keeps unknown ids on purpose (so a budget over a
// since-deleted category still matches its old transactions). Refusing at the
// point of CREATION and keeping it at the point of CALCULATION is the
// combination that gives both.
import Foundation

/// A budget as a form holds it.
public struct BudgetDraft: Sendable, Hashable {
    /// nil to create; present to update that row.
    public var id: String?
    public var name: String
    /// The categories the budget covers. Descendants are included at
    /// calculation time (D16) and are NOT stored here -- storing them would
    /// freeze the tree as it was on the day the budget was made.
    public var categoryIds: [String]
    /// Positive minor units, in the BASE currency (D22).
    public var amountMinor: Int64
    public var period: BudgetPeriod
    /// 'YYYY-MM-DD'. The anchor the whole window grid is built from.
    public var startDate: String
    public var archived: Bool?

    public init(
        id: String? = nil,
        name: String,
        categoryIds: [String],
        amountMinor: Int64,
        period: BudgetPeriod,
        startDate: String,
        archived: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.categoryIds = categoryIds
        self.amountMinor = amountMinor
        self.period = period
        self.startDate = startDate
        self.archived = archived
    }

    /// The draft that edits an existing budget.
    public init(editing budget: Budget) {
        self.init(
            id: budget.id, name: budget.name, categoryIds: budget.categoryIds,
            amountMinor: budget.amountMinor, period: budget.period,
            startDate: budget.startDate, archived: budget.archived
        )
    }
}

extension LedgerStore {

    // MARK: - Reads

    /// Every budget that has not been deleted, archived ones included. The
    /// screen decides which section each belongs in; this decides nothing.
    public func budgets() throws -> [Budget] {
        try readBudgets(from: "live_budgets")
    }

    public func budget(id: String) throws -> Budget? {
        try budgets().first { $0.id == id }
    }

    // MARK: - Writes

    /// Create or update a budget.
    @discardableResult
    public func saveBudget(_ draft: BudgetDraft) throws -> Budget {
        try connection.transaction {
            let name = Names.clean(draft.name)
            guard !name.isEmpty else { throw EditError.blankName(what: "budget") }
            guard draft.amountMinor > 0 else {
                throw EditError.budgetAmountNotPositive(draft.amountMinor)
            }
            // Duplicates collapsed, order kept: the owner's order is the order
            // the editor shows them back in.
            var seen = Set<String>()
            let categoryIds = draft.categoryIds.filter { id in
                !id.isEmpty && seen.insert(id).inserted
            }
            guard !categoryIds.isEmpty else { throw EditError.budgetNeedsACategory }
            for id in categoryIds where try !liveRowExists("categories", id: id) {
                throw EditError.unknownCategory(id)
            }
            guard CalendarDate(iso: draft.startDate) != nil else {
                throw EditError.badDate(draft.startDate)
            }

            var existing: Budget? = nil
            if let id = draft.id {
                guard let found = try budget(id: id) else { throw EditError.unknownBudget(id) }
                existing = found
            }

            let budget = Budget(
                id: existing?.id ?? environment.newId(),
                name: name,
                categoryIds: categoryIds,
                amountMinor: draft.amountMinor,
                period: draft.period,
                startDate: draft.startDate,
                // Phase 2, preserved rather than editable -- exactly as the
                // TypeScript preserves it. A field this build does not offer is
                // not a field this build may quietly clear.
                rollover: existing?.rollover ?? false,
                archived: draft.archived ?? existing?.archived ?? false
            )

            if existing == nil {
                let insert = try connection.prepare(
                    """
                    INSERT INTO budgets (
                        id, name, amount_minor, period, start_date, rollover, archived, deleted_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                    """
                )
                defer { insert.finalize() }
                bindBudget(budget, to: insert)
                try insert.run()
            } else {
                let update = try connection.prepare(
                    """
                    UPDATE budgets SET
                        name = ?2, amount_minor = ?3, period = ?4, start_date = ?5,
                        rollover = ?6, archived = ?7
                    WHERE id = ?1 AND deleted_at IS NULL
                    """
                )
                defer { update.finalize() }
                bindBudget(budget, to: update)
                try update.run()
                guard try changedRows() > 0 else { throw EditError.unknownBudget(budget.id) }
            }

            // The link rows are REPLACED WHOLESALE rather than diffed. They
            // carry a position and no identity of their own, so a diff would be
            // more code for the same bytes -- and `budget_categories` has no
            // tombstone column because it is not a record, it is part of the
            // budget it belongs to.
            try replaceBudgetCategories(budgetId: budget.id, categoryIds: categoryIds)

            try recordLocalEdit(at: environment.now())
            return budget
        }
    }

    /// Retire a budget, or bring it back. Touches ONE column.
    ///
    /// An archived budget keeps its categories, its limit and its history; it
    /// stops appearing among the live ones and takes no part in the dashboard.
    /// This is the answer offered instead of deleting, and the reason deleting
    /// is rarely the right button.
    public func setBudgetArchived(id: String, archived: Bool) throws {
        try connection.transaction {
            guard let budget = try budget(id: id) else { throw EditError.unknownBudget(id) }
            // Already in that state: not an error, and not a change either, so
            // the divergence counter does not tick for a tap that did nothing.
            guard budget.archived != archived else { return }
            let statement = try connection.prepare(
                "UPDATE budgets SET archived = ? WHERE id = ? AND deleted_at IS NULL"
            )
            defer { statement.finalize() }
            statement.bind(1, flag: archived)
            statement.bind(2, text: id)
            try statement.run()
            guard try changedRows() > 0 else { throw EditError.unknownBudget(id) }
            try recordLocalEdit(at: environment.now())
        }
    }

    /// Tombstone a budget. See the file header for why this is not a delete.
    ///
    /// No transaction is touched. A budget is a lens over spending that already
    /// happened, so removing it removes a view and never a record -- which is
    /// exactly what the returned receipt lets the UI say.
    public func deleteBudget(id: String) throws -> DeletedRecord {
        try connection.transaction {
            guard let budget = try budget(id: id) else { throw EditError.unknownBudget(id) }
            let now = environment.now()
            guard try softDelete(table: "budgets", id: id, at: now) else {
                throw EditError.unknownBudget(id)
            }
            try recordLocalEdit(at: now)
            return DeletedRecord(table: "budgets", id: id, deletedAt: now, name: budget.name)
        }
    }

    // MARK: - Plumbing

    private func bindBudget(_ budget: Budget, to statement: SQLiteStatement) {
        statement.bind(1, text: budget.id)
        statement.bind(2, text: budget.name)
        statement.bind(3, minorUnits: budget.amountMinor)  // MONEY, base currency (D22)
        statement.bind(4, text: budget.period.rawValue)
        statement.bind(5, text: budget.startDate)
        statement.bind(6, flag: budget.rollover)
        statement.bind(7, flag: budget.archived)
    }

    private func replaceBudgetCategories(budgetId: String, categoryIds: [String]) throws {
        let clear = try connection.prepare("DELETE FROM budget_categories WHERE budget_id = ?")
        defer { clear.finalize() }
        clear.bind(1, text: budgetId)
        try clear.run()

        let link = try connection.prepare(
            "INSERT INTO budget_categories (budget_id, position, category_id) VALUES (?, ?, ?)"
        )
        defer { link.finalize() }
        for (position, categoryId) in categoryIds.enumerated() {
            link.bind(1, text: budgetId)
            link.bind(2, integer: position)
            link.bind(3, text: categoryId)
            try link.run()
        }
    }
}
