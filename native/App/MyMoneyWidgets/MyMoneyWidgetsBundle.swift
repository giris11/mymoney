// The widgets this app offers.
//
// TWO OF THEM, both reading the one snapshot file the app publishes: what the
// accounts come to, and how this month is going against the budgets. Neither
// opens a database, neither computes anything, and both print how old their
// figures are.
import SwiftUI
import WidgetKit

@main
struct MyMoneyWidgets: WidgetBundle {
    var body: some Widget {
        NetWorthWidget()
        BudgetWidget()
    }
}
