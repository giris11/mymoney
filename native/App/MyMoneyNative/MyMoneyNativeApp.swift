// MyMoney, natively -- a READ-ONLY window onto a backup of the owner's book.
//
// WHAT THIS APP IS. The web app (TypeScript, React, Dexie) is the system of
// record and stays so. This one imports a backup file that app exported, keeps
// a private SQLite copy of it, and shows two things: what the accounts are
// worth, and every transaction behind them. It has no editor, no add button and
// no delete, and it says so on every screen. Nothing it can do can change the
// real ledger, which is the point: a second app that could write to the same
// money before the sync story is settled is how two truths get created.
//
// EVERY FIGURE ON EVERY SCREEN COMES FROM MyMoneyKit -- the same package that
// passes 284 oracle cases against the TypeScript, imports the owner's real
// backup and re-exports it to an identical canonical hash. There is no
// arithmetic in the views and no NumberFormatter anywhere in this target.
//
// One target, two platforms: iOS 17 and macOS 14, one SwiftUI code path.
import SwiftUI

@main
struct MyMoneyNativeApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
        #if os(macOS)
            .defaultSize(width: 1080, height: 720)
            .commands {
                // The app has no editing commands to offer, so the menus it
                // would otherwise inherit are removed rather than left there
                // greyed out suggesting that editing exists somewhere.
                CommandGroup(replacing: .newItem) {}
                CommandGroup(replacing: .pasteboard) {}
            }
        #endif
    }
}
