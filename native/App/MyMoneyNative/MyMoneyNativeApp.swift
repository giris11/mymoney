// MyMoney, natively -- a READ-ONLY window onto a backup of the owner's book.
//
// WHAT THIS APP IS. The web app (TypeScript, React, Dexie) is the system of
// record and stays so. This one imports a backup file that app exported and
// keeps a PRIVATE SQLITE COPY of it. It can now edit that copy -- add, change
// and delete -- and it still cannot touch the real ledger: there is no method
// anywhere in this target that writes to the web app, and there cannot be one.
//
// WHICH MAKES DIVERGENCE THE THING TO BE HONEST ABOUT rather than the thing to
// prevent. Every mutation increments a count inside its own transaction, and
// that count is on screen permanently -- "6 changes not in your web app". It is
// on the WIDGET too, for the same reason: a net worth on a home screen that
// quietly includes edits the browser has never seen would be the worst place in
// the system to leave that unsaid.
//
// FOUR THINGS ONLY A NATIVE APP CAN DO were added last: a Face ID lock in front
// of the app (a curtain, not a safe -- see AppLock.swift), home and lock screen
// widgets fed by a small published snapshot, App Intents that write a
// transaction by voice THROUGH THE SAME store API as the UI, and a share sheet
// that identifies an arriving file by its bytes rather than its name. Every one
// of them is written down where it lives, including what it does not do.
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
    /// BUILT HERE, BEFORE THE FIRST FRAME. `AppLockModel.init` decides that a
    /// launch is locked; doing that in a `.task` on a view would leave one
    /// frame in which the accounts screen is drawn and then covered, and one
    /// frame is a screenshot.
    @State private var lock = AppLockModel()

    var body: some Scene {
        WindowGroup {
            RootView(lock: lock)
                .environment(model)
        }
        #if os(macOS)
            .defaultSize(width: 1080, height: 720)
            .commands {
                // The app's own adding is a bar at the bottom of the sidebar
                // rather than a File > New, and it has no document model for a
                // "New" command to mean anything against -- so the menus it
                // would otherwise inherit are removed rather than left greyed
                // out suggesting a route that does not exist.
                CommandGroup(replacing: .newItem) {}
                CommandGroup(replacing: .pasteboard) {}
            }
        #endif
    }
}
