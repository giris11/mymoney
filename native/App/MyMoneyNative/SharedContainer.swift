// What the app says about the directory it shares with its widget.
//
// The LOOKUP is in the kit (`SharedGroup`), so that the app and the widget find
// the container the same way and read the identifier from the same build
// setting. What is here is only the WORDS -- what the settings screen tells the
// owner when there is a shared container and when there is not.
//
// THERE IS OFTEN NOT ONE, AND THAT IS NOT A FAULT. An App Group is a signing
// capability as well as a string: it has to be registered against the developer
// account and carried by the provisioning profile. This project's device build
// is signed with a wildcard team profile that does not carry it, because adding
// it needs an Apple ID signed in to Xcode. Consequences, stated rather than
// hidden:
//
//   * the app runs exactly as before and publishes no snapshot;
//   * the widget says "open MyMoney" instead of showing a figure;
//   * nothing crashes, nothing is lost, and no number is invented.
//
// Turning it on is one checkbox on each of the two targets (Signing &
// Capabilities -> + App Groups -> the identifier in `MYMONEY_APP_GROUP`) and no
// code change at all. The simulator needs no profile, so the whole path runs
// there today.
//
// AND THE DATABASE STAYS OUT OF THE CONTAINER. One small JSON snapshot goes in
// it, and nothing else. The ledger lives in Application Support where only this
// app can reach it -- see `LedgerSnapshot`'s header for why a widget must not
// open a database at all.
import Foundation
import MyMoneyKit

enum SharedContainer {
    static var identifier: String? { SharedGroup.identifier() }

    static var url: URL? { SharedGroup.containerURL() }

    static var isAvailable: Bool { url != nil }

    /// What the settings screen says, in the owner's words rather than in
    /// entitlement names.
    static var explanation: String {
        isAvailable
            ? "Your net worth and your budgets are published to the widget every time you open "
                + "the app or change something. The widget always prints how old the figures are."
            : "Widgets are off in this build: it is not signed with the shared-container "
                + "capability they need. Everything else works normally."
    }
}
