// Handing the widget its figures, and waking it only when they moved.
//
// TWO THINGS HAPPEN HERE AND THEY ARE DIFFERENT THINGS.
//
//   * The FILE is rewritten on every call. Its `asOf` stamp is what lets a
//     widget show an old figure honestly, and a stamp that was not refreshed
//     when the app last looked at the book would be a lie in the other
//     direction -- claiming the figures are older than they are.
//   * WIDGETKIT IS WOKEN ONLY WHEN A FIGURE MOVED. Reloads are rationed by the
//     system; spending one on "nothing changed" is spending one that a real
//     change needed later. The widget's own timeline refreshes hourly anyway,
//     which is what keeps its "as at" line moving.
//
// A build with no shared container publishes nothing and says nothing about it
// -- `SharedContainer` explains why that is a normal state rather than a fault.
import Foundation
import MyMoneyKit
import WidgetKit

enum WidgetPublishing {
    /// Publish, and reload the widgets when the figures actually changed.
    @MainActor
    static func publish(using service: LedgerService) async {
        guard let directory = SharedContainer.url else { return }
        let changed = await service.publishSnapshot(today: todayISO(), to: directory)
        if changed {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
